//! X11: Bildschirm per GetImage, Fenster über EWMH (ohne Fenstermanager über
//! den Fensterbaum). Reines Rust über x11rb, ohne libX11.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;
use x11rb::CURRENT_TIME;

use super::{Caps, Rect, Shot, WinInfo};

type CmdResult<T> = Result<T, String>;

fn connect() -> CmdResult<(RustConnection, usize)> {
    if std::env::var("DISPLAY").map_or(true, |d| d.is_empty()) {
        return Err("Kein Bildschirm gefunden (DISPLAY ist nicht gesetzt).".into());
    }
    x11rb::connect(None).map_err(|e| format!("Keine Verbindung zum X-Server: {e}"))
}

fn e(err: impl std::fmt::Display) -> String {
    format!("X11: {err}")
}

pub fn capture() -> CmdResult<Shot> {
    let (c, n) = connect()?;
    let setup = c.setup();
    let screen = &setup.roots[n];
    let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
    let reply = get_image(&c, ImageFormat::Z_PIXMAP, screen.root, 0, 0, w, h, !0).map_err(e)?.reply().map_err(e)?;
    let bpp = setup.pixmap_formats.iter().find(|f| f.depth == reply.depth).map_or(0, |f| f.bits_per_pixel);
    if bpp != 32 {
        return Err(format!("X11: Farbtiefe {} ({bpp} bpp) wird nicht unterstützt.", reply.depth));
    }
    let lsb = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let mut img = image::RgbaImage::new(w as u32, h as u32);
    for (px, chunk) in img.pixels_mut().zip(reply.data.chunks_exact(4)) {
        *px = if lsb { image::Rgba([chunk[2], chunk[1], chunk[0], 255]) } else { image::Rgba([chunk[1], chunk[2], chunk[3], 255]) };
    }
    Ok(Shot { img, ox: 0.0, oy: 0.0, unit: 1.0 })
}

struct Atoms {
    client_list: Atom,
    active: Atom,
    name: Atom,
    utf8: Atom,
    pid: Atom,
    state: Atom,
    hidden: Atom,
}

fn atom(c: &RustConnection, name: &str) -> CmdResult<Atom> {
    Ok(intern_atom(c, false, name.as_bytes()).map_err(e)?.reply().map_err(e)?.atom)
}

fn atoms(c: &RustConnection) -> CmdResult<Atoms> {
    Ok(Atoms {
        client_list: atom(c, "_NET_CLIENT_LIST")?,
        active: atom(c, "_NET_ACTIVE_WINDOW")?,
        name: atom(c, "_NET_WM_NAME")?,
        utf8: atom(c, "UTF8_STRING")?,
        pid: atom(c, "_NET_WM_PID")?,
        state: atom(c, "_NET_WM_STATE")?,
        hidden: atom(c, "_NET_WM_STATE_HIDDEN")?,
    })
}

fn prop32(c: &RustConnection, win: Window, prop: Atom, ty: impl Into<Atom>) -> Vec<u32> {
    get_property(c, false, win, prop, ty, 0, 4096)
        .ok()
        .and_then(|r| r.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn title(c: &RustConnection, a: &Atoms, win: Window) -> String {
    let get = |prop: Atom, ty: Atom| {
        get_property(c, false, win, prop, ty, 0, 1024).ok().and_then(|r| r.reply().ok()).map(|r| String::from_utf8_lossy(&r.value).to_string()).unwrap_or_default()
    };
    let t = get(a.name, a.utf8);
    if t.is_empty() { get(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()) } else { t }
}

fn class(c: &RustConnection, win: Window) -> String {
    get_property(c, false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
        .ok()
        .and_then(|r| r.reply().ok())
        .map(|r| {
            let parts: Vec<String> = r.value.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).to_string()).collect();
            parts.last().cloned().unwrap_or_default()
        })
        .unwrap_or_default()
}

/// Fenster mit Titel: EWMH-Liste des Fenstermanagers, sonst sichtbare Kinder
/// der Wurzel (und deren Kinder, falls ein Fenstermanager ohne EWMH umrahmt).
fn top_windows(c: &RustConnection, root: Window, a: &Atoms) -> Vec<Window> {
    let list = prop32(c, root, a.client_list, AtomEnum::WINDOW);
    if !list.is_empty() {
        return list;
    }
    let children = |w: Window| query_tree(c, w).ok().and_then(|r| r.reply().ok()).map(|r| r.children).unwrap_or_default();
    let viewable = |w: Window| get_window_attributes(c, w).ok().and_then(|r| r.reply().ok()).is_some_and(|r| r.map_state == MapState::VIEWABLE);
    let mut out = Vec::new();
    for w in children(root) {
        if !viewable(w) {
            continue;
        }
        if !title(c, a, w).is_empty() {
            out.push(w);
        } else if let Some(inner) = children(w).into_iter().find(|x| !title(c, a, *x).is_empty()) {
            out.push(inner);
        }
    }
    out
}

fn active(c: &RustConnection, root: Window, a: &Atoms) -> Option<Window> {
    prop32(c, root, a.active, AtomEnum::WINDOW).first().copied().filter(|w| *w != 0).or_else(|| get_input_focus(c).ok()?.reply().ok().map(|r| r.focus).filter(|w| *w > 1))
}

pub fn windows() -> CmdResult<Vec<WinInfo>> {
    let (c, n) = connect()?;
    let root = c.setup().roots[n].root;
    let a = atoms(&c)?;
    let focused = active(&c, root, &a);
    let me = std::process::id();
    let mut out = Vec::new();
    for w in top_windows(&c, root, &a) {
        let name = title(&c, &a, w);
        if name.is_empty() {
            continue;
        }
        let Some(geo) = get_geometry(&c, w).ok().and_then(|r| r.reply().ok()) else { continue };
        let Some(pos) = translate_coordinates(&c, w, root, 0, 0).ok().and_then(|r| r.reply().ok()) else { continue };
        let mapped = get_window_attributes(&c, w).ok().and_then(|r| r.reply().ok()).is_some_and(|r| r.map_state == MapState::VIEWABLE);
        let hidden = prop32(&c, w, a.state, AtomEnum::ATOM).contains(&a.hidden);
        let pid = prop32(&c, w, a.pid, AtomEnum::CARDINAL).first().copied();
        out.push(WinInfo {
            id: w as u64,
            title: name,
            app: class(&c, w),
            rect: Rect { x: pos.dst_x as f64, y: pos.dst_y as f64, w: geo.width as f64, h: geo.height as f64 },
            focused: focused == Some(w),
            minimized: hidden || !mapped,
            brise: pid == Some(me),
        });
    }
    Ok(out)
}

pub fn focus(id: u64) -> CmdResult<()> {
    let (c, n) = connect()?;
    let root = c.setup().roots[n].root;
    let a = atoms(&c)?;
    let win = id as Window;
    map_window(&c, win).map_err(e)?;
    // Mit Fenstermanager: höflich über _NET_ACTIVE_WINDOW bitten.
    let event = ClientMessageEvent::new(32, win, a.active, [2u32, CURRENT_TIME, 0, 0, 0]);
    send_event(&c, false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).map_err(e)?;
    configure_window(&c, win, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE)).map_err(e)?;
    let _ = set_input_focus(&c, InputFocus::PARENT, win, CURRENT_TIME);
    c.flush().map_err(e)?;
    // Auf den Server warten, damit der nächste Screenshot das Ergebnis zeigt.
    get_input_focus(&c).map_err(e)?.reply().map_err(e)?;
    std::thread::sleep(std::time::Duration::from_millis(150));
    Ok(())
}

/// Titel des aktiven Fensters (für die Passwort-Prüfung vor dem Tippen).
pub fn active_title() -> Option<String> {
    let (c, n) = connect().ok()?;
    let root = c.setup().roots[n].root;
    let a = atoms(&c).ok()?;
    let mut w = active(&c, root, &a)?;
    // Der Fokus liegt oft auf einem Kindfenster ohne Titel – zum Elternfenster hoch.
    for _ in 0..6 {
        let t = title(&c, &a, w);
        if !t.is_empty() {
            return Some(t);
        }
        let parent = query_tree(&c, w).ok()?.reply().ok()?.parent;
        if parent == root || parent == 0 {
            break;
        }
        w = parent;
    }
    None
}

pub fn capabilities() -> Caps {
    let mut caps = Caps { backend: "x11".into(), windows: true, ..Default::default() };
    match connect() {
        Ok((c, n)) => {
            let s = &c.setup().roots[n];
            caps.screenshot = true;
            caps.screenshot_detail = format!("X11-Bildschirm {}×{}", s.width_in_pixels, s.height_in_pixels);
            let xtest = query_extension(&c, b"XTEST").ok().and_then(|r| r.reply().ok()).is_some_and(|r| r.present);
            caps.input = xtest;
            caps.input_detail = if xtest { "XTest verfügbar".into() } else { "Die XTest-Erweiterung fehlt auf diesem X-Server".into() };
            if prop32(&c, s.root, atom(&c, "_NET_CLIENT_LIST").unwrap_or(0), AtomEnum::WINDOW).is_empty() {
                caps.notes.push("Kein EWMH-Fenstermanager – Fensterliste über den Fensterbaum.".into());
            }
        }
        Err(err) => {
            caps.screenshot_detail = err.clone();
            caps.input_detail = err;
            caps.windows = false;
        }
    }
    caps
}
