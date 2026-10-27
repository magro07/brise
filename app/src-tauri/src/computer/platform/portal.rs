//! Wayland über xdg-desktop-portal: Screenshots über `org.freedesktop.portal.Screenshot`,
//! Eingaben über `org.freedesktop.portal.RemoteDesktop` (mit ScreenCast für
//! absolute Mauspositionen). Das System fragt einmal nach; das Token merkt
//! sich Brise, damit die Abfrage nicht bei jedem Start kommt. Ohne Portal
//! hilft `ydotool`, falls installiert.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ashpd::desktop::remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::screencast::{Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::screenshot::{Screenshot, ScreenshotProxy};
use ashpd::desktop::{PersistMode, Session};
use ashpd::enumflags2::BitFlags;
use futures_util::StreamExt;
use tokio::sync::Mutex;

use super::{Button, Caps, Input, Shot};
use crate::computer::keys::{char_keysym, keysym};

type CmdResult<T> = Result<T, String>;

/// Linux-Evdev-Codes der Maustasten.
const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;
const BTN_MIDDLE: i32 = 0x112;

struct StreamGeo {
    node: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct Remote {
    proxy: RemoteDesktop,
    session: std::sync::Arc<Session<RemoteDesktop>>,
    streams: Vec<StreamGeo>,
}

static REMOTE: Mutex<Option<Remote>> = Mutex::const_new(None);
/// Zählt aufgebaute Sitzungen, damit ein später Abbruch nicht die nächste trifft.
static REMOTE_GEN: AtomicU64 = AtomicU64::new(0);
/// Größe des letzten Portal-Screenshots (Pixel) – für die Umrechnung auf das logische Layout.
static LAST: std::sync::Mutex<(u32, u32)> = std::sync::Mutex::new((0, 0));

fn e(err: impl std::fmt::Display) -> String {
    format!("Portal: {err}")
}

/// `file:///…` mit Prozent-Kodierung in einen Pfad.
fn uri_path(uri: &str) -> Option<std::path::PathBuf> {
    let raw = uri.strip_prefix("file://")?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(std::path::PathBuf::from(String::from_utf8(out).ok()?))
}

pub async fn capture() -> CmdResult<Shot> {
    let response = Screenshot::request()
        .interactive(false)
        .modal(false)
        .send()
        .await
        .map_err(e)?
        .response()
        .map_err(|err| format!("Screenshot über das Portal abgelehnt oder fehlgeschlagen ({err}). Unter GNOME: Einstellungen → Apps → Brise → Screenshots erlauben."))?;
    let path = uri_path(response.uri().as_str()).ok_or("Portal: unerwartete Screenshot-Adresse")?;
    let bytes = std::fs::read(&path).map_err(|err| format!("Portal-Screenshot lesen: {err}"))?;
    // Die Datei hat das Portal eigens für diese Anfrage angelegt.
    let _ = std::fs::remove_file(&path);
    let img = image::load_from_memory(&bytes).map_err(e)?.to_rgba8();
    *LAST.lock().unwrap_or_else(|p| p.into_inner()) = img.dimensions();
    Ok(Shot { img, ox: 0.0, oy: 0.0, unit: 1.0 })
}

async fn start_remote() -> CmdResult<Remote> {
    let token = crate::computer::settings().portal_token;
    let proxy = RemoteDesktop::new().await.map_err(e)?;
    let cast = Screencast::new().await.map_err(e)?;
    let session = proxy.create_session(Default::default()).await.map_err(e)?;
    let mut devices = SelectDevicesOptions::default().set_devices(DeviceType::Keyboard | DeviceType::Pointer);
    if proxy.version() >= 2 {
        devices = devices.set_persist_mode(PersistMode::ExplicitlyRevoked).set_restore_token(token.as_deref());
    }
    proxy.select_devices(&session, devices).await.map_err(e)?.response().map_err(e)?;
    // Bildschirme braucht das Portal für absolute Mauspositionen.
    cast.select_sources(&session, SelectSourcesOptions::default().set_sources(BitFlags::from(SourceType::Monitor)).set_multiple(true))
        .await
        .map_err(e)?
        .response()
        .map_err(e)?;
    let selected = proxy
        .start(&session, None, Default::default())
        .await
        .map_err(e)?
        .response()
        .map_err(|err| format!("Fernsteuerung nicht freigegeben ({err}). Brise fragt beim nächsten Versuch erneut."))?;
    eprintln!(
        "computer use: Portal gab frei: {:?}, Bildschirme {:?}",
        selected.devices(),
        selected.streams().iter().map(|s| (s.position(), s.size())).collect::<Vec<_>>()
    );
    // Eine Freigabe ohne Maus nicht merken – sonst stellt das Portal genau
    // diese Auswahl künftig ohne Rückfrage wieder her.
    if !selected.devices().contains(DeviceType::Pointer) {
        crate::computer::save_portal_token(None);
        return Err("Das System hat nur den Bildschirm freigegeben, nicht Maus und Tastatur. Unter GNOME im Dialog „Entfernter Bildschirm“ den Schalter „Fernzugriff zulassen“ einschalten (am besten auch „Diese Auswahl merken“) und erneut versuchen.".into());
    }
    crate::computer::save_portal_token(selected.restore_token().map(str::to_string));
    let streams = selected
        .streams()
        .iter()
        .map(|s| {
            let (x, y) = s.position().unwrap_or((0, 0));
            let (w, h) = s.size().unwrap_or((0, 0));
            StreamGeo { node: s.pipe_wire_node_id(), x: x as f64, y: y as f64, w: w as f64, h: h as f64 }
        })
        .collect();
    // Beendet der Nutzer die Fernsteuerung über das System, ist das ein Not-Aus.
    let generation = REMOTE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let session = std::sync::Arc::new(session);
    let watched = session.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(closed) = watched.receive_closed().await else { return };
        let mut closed = std::pin::pin!(closed);
        if closed.next().await.is_some() && REMOTE_GEN.load(Ordering::SeqCst) == generation {
            *REMOTE.lock().await = None;
            crate::computer::system_stop();
        }
    });
    Ok(Remote { proxy, session, streams })
}

/// Bildpunkt des letzten Screenshots → (Stream, Position im Stream).
/// Die Portale melden Stream-Lage und -Größe logisch. Mutter (GNOME) erwartet
/// Mauspositionen im Stream aber in Bildschirmpixeln – es teilt sie wieder durch
/// den Skalierungsfaktor (`meta_screen_cast_monitor_stream_transform_position`) –,
/// KWin dagegen logisch. `physical` wählt die GNOME-Rechnung.
fn locate(streams: &[StreamGeo], x: f64, y: f64, physical: bool) -> CmdResult<(u32, f64, f64)> {
    let (min_x, min_y) = streams.iter().fold((f64::MAX, f64::MAX), |(a, b), s| (a.min(s.x), b.min(s.y)));
    let max_x = streams.iter().map(|s| s.x + s.w).fold(0.0, f64::max);
    let (pw, _) = *LAST.lock().unwrap_or_else(|p| p.into_inner());
    if streams.is_empty() || max_x <= min_x {
        return Err("Das Portal hat keinen Bildschirm geliefert – Fernsteuerung neu freigeben (Einstellungen → Computer Use).".into());
    }
    // Screenshot (physische Pixel) → logisches Layout der Bildschirme.
    let scale = if pw > 0 { pw as f64 / (max_x - min_x) } else { 1.0 };
    let (lx, ly) = (min_x + x / scale, min_y + y / scale);
    let s = streams.iter().find(|s| lx >= s.x && ly >= s.y && lx < s.x + s.w && ly < s.y + s.h).unwrap_or(&streams[0]);
    let f = if physical { scale } else { 1.0 };
    Ok((s.node, ((lx - s.x) * f).clamp(0.0, (s.w * f - 1.0).max(0.0)), ((ly - s.y) * f).clamp(0.0, (s.h * f - 1.0).max(0.0))))
}

/// GNOME/Mutter rechnet Stream-Positionen in Bildschirmpixeln (siehe `locate`).
fn mutter() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.split(':').any(|x| x.eq_ignore_ascii_case("gnome")))
}

async fn remote() -> CmdResult<tokio::sync::MutexGuard<'static, Option<Remote>>> {
    let mut guard = REMOTE.lock().await;
    if guard.is_none() {
        *guard = Some(start_remote().await?);
    }
    Ok(guard)
}

pub async fn input(a: Input) -> CmdResult<()> {
    let guard = match remote().await {
        Ok(g) => g,
        Err(err) if ydotool() => {
            eprintln!("Computer Use: Portal nicht verfügbar ({err}), nutze ydotool");
            return tokio::task::spawn_blocking(move || ydo(&a)).await.map_err(|x| x.to_string())?;
        }
        Err(err) => return Err(err),
    };
    let r = guard.as_ref().expect("Sitzung gestartet");
    let result = send(r, &a).await;
    if result.is_err() {
        // Sitzung vom System beendet (z. B. Stopp in der GNOME-Leiste) – beim nächsten Mal neu aufbauen.
        drop(guard);
        *REMOTE.lock().await = None;
    }
    result
}

async fn pause(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn send(r: &Remote, a: &Input) -> CmdResult<()> {
    let (p, s) = (&r.proxy, &r.session);
    let to = |x: f64, y: f64| async move {
        let (node, lx, ly) = locate(&r.streams, x, y, mutter())?;
        p.notify_pointer_motion_absolute(s, node, lx, ly, Default::default()).await.map_err(e)?;
        pause(30).await;
        Ok::<(), String>(())
    };
    let press = |b: i32, state: KeyState| async move { p.notify_pointer_button(s, b, state, Default::default()).await.map_err(e) };
    let key = |sym: u32, state: KeyState| async move { p.notify_keyboard_keysym(s, sym as i32, state, Default::default()).await.map_err(e) };
    match a {
        Input::Move { x, y } => to(*x, *y).await,
        Input::Click { x, y, button, count } => {
            to(*x, *y).await?;
            let b = match button {
                Button::Left => BTN_LEFT,
                Button::Right => BTN_RIGHT,
                Button::Middle => BTN_MIDDLE,
            };
            for i in 0..*count {
                if i > 0 {
                    pause(70).await;
                }
                press(b, KeyState::Pressed).await?;
                pause(20).await;
                press(b, KeyState::Released).await?;
            }
            Ok(())
        }
        Input::Drag { from, to: dest } => {
            to(from.0, from.1).await?;
            press(BTN_LEFT, KeyState::Pressed).await?;
            let steps = 12;
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                if let Err(err) = to(from.0 + (dest.0 - from.0) * t, from.1 + (dest.1 - from.1) * t).await {
                    let _ = press(BTN_LEFT, KeyState::Released).await;
                    return Err(err);
                }
            }
            press(BTN_LEFT, KeyState::Released).await
        }
        Input::Scroll { x, y, dx, dy } => {
            to(*x, *y).await?;
            if *dy != 0 {
                p.notify_pointer_axis_discrete(s, Axis::Vertical, *dy, Default::default()).await.map_err(e)?;
            }
            if *dx != 0 {
                p.notify_pointer_axis_discrete(s, Axis::Horizontal, *dx, Default::default()).await.map_err(e)?;
            }
            Ok(())
        }
        Input::Text(t) => {
            for c in t.chars() {
                let sym = char_keysym(c);
                key(sym, KeyState::Pressed).await?;
                key(sym, KeyState::Released).await?;
                pause(8).await;
            }
            Ok(())
        }
        Input::Keys(keys) => {
            let syms: Vec<u32> = keys.iter().map(|k| keysym(*k)).collect();
            for sym in &syms {
                key(*sym, KeyState::Pressed).await?;
            }
            pause(30).await;
            for sym in syms.iter().rev() {
                key(*sym, KeyState::Released).await?;
            }
            Ok(())
        }
    }
}

pub async fn release_all() {
    let guard = REMOTE.lock().await;
    if let Some(r) = guard.as_ref() {
        for b in [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE] {
            let _ = r.proxy.notify_pointer_button(&r.session, b, KeyState::Released, Default::default()).await;
        }
        for sym in [0xffe3u32, 0xffe1, 0xffe9, 0xffeb] {
            let _ = r.proxy.notify_keyboard_keysym(&r.session, sym as i32, KeyState::Released, Default::default()).await;
        }
    }
}

/// Freigabe jetzt einholen (Knopf in den Einstellungen).
pub async fn prepare() -> CmdResult<String> {
    let guard = remote().await?;
    let n = guard.as_ref().map_or(0, |r| r.streams.len());
    Ok(format!("Fernsteuerung freigegeben ({n} Bildschirm{}). GNOME zeigt oben rechts ein Symbol, solange sie besteht – dort lässt sie sich auch beenden.", if n == 1 { "" } else { "e" }))
}

pub async fn capabilities() -> Caps {
    let mut caps = Caps { backend: "wayland-portal".into(), ..Default::default() };
    match ScreenshotProxy::new().await {
        Ok(p) => {
            caps.screenshot = true;
            caps.screenshot_detail = format!("Screenshot-Portal v{} – das System fragt beim ersten Mal nach", p.version());
        }
        Err(err) => caps.screenshot_detail = format!("Screenshot-Portal fehlt: {err}"),
    }
    match RemoteDesktop::new().await {
        Ok(p) => {
            let types = p.available_device_types().await.unwrap_or_default();
            caps.input = types.contains(DeviceType::Pointer) && types.contains(DeviceType::Keyboard);
            caps.input_detail = if caps.input {
                format!(
                    "RemoteDesktop-Portal v{}{}",
                    p.version(),
                    if crate::computer::settings().portal_token.is_some() { " – bereits freigegeben" } else { " – einmalige Freigabe beim ersten Klick" }
                )
            } else {
                "RemoteDesktop-Portal ohne Maus/Tastatur".into()
            };
        }
        Err(err) => caps.input_detail = format!("RemoteDesktop-Portal fehlt: {err}"),
    }
    if !caps.input && ydotool() {
        caps.input = true;
        caps.input_detail = "ydotool (Rückfall ohne Portal)".into();
    }
    caps.notes.push("Unter Wayland gibt es keine Fensterliste; Brise minimiert sich während Screenshots und Eingaben, damit es weder im Bild steht noch selbst angeklickt wird.".into());
    caps.notes.push("GNOME-Dialog „Entfernter Bildschirm“: „Fernzugriff zulassen“ einschalten und „Diese Auswahl merken“ anhaken.".into());
    caps.notes.push("Danach kann sich Brise nicht selbst nach vorn holen: Bei einer neuen Freigabekarte meldet GNOME „Brise ist bereit“ – anklicken.".into());
    caps.notes.push("Not-Aus unter GNOME: Fernsteuerungs-Symbol oben rechts → Beenden (bricht ab und nimmt Freigaben zurück), oder der Stopp-Knopf in Brise.".into());
    caps
}

// ---------- Rückfall ydotool ----------

fn ydotool() -> bool {
    super::which("ydotool")
}

fn ydo_run(args: &[String]) -> CmdResult<()> {
    let out = Command::new("ydotool").args(args).output().map_err(|err| format!("ydotool: {err}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("ydotool: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Evdev-Code einer Taste (US-Belegung) für `ydotool key`.
fn evdev(k: crate::computer::keys::Key) -> Option<u16> {
    use crate::computer::keys::Key as K;
    Some(match k {
        K::Ctrl => 29,
        K::Shift => 42,
        K::Alt => 56,
        K::Meta => 125,
        K::Return => 28,
        K::Escape => 1,
        K::Tab => 15,
        K::Backspace => 14,
        K::Delete => 111,
        K::Insert => 110,
        K::Home => 102,
        K::End => 107,
        K::PageUp => 104,
        K::PageDown => 109,
        K::Left => 105,
        K::Right => 106,
        K::Up => 103,
        K::Down => 108,
        K::Space => 57,
        K::F(n @ 1..=10) => 58 + n as u16,
        K::F(11) => 87,
        K::F(12) => 88,
        K::Char(c) => {
            const ROWS: [(&str, u16); 4] = [("1234567890", 2), ("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)];
            ROWS.iter().find_map(|(row, start)| row.find(c).map(|i| start + i as u16))?
        }
        _ => return None,
    })
}

fn ydo(a: &Input) -> CmdResult<()> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let mv = |x: f64, y: f64| ydo_run(&s(&["mousemove", "--absolute", "-x", &x.round().to_string(), "-y", &y.round().to_string()]));
    match a {
        Input::Move { x, y } => mv(*x, *y),
        Input::Click { x, y, button, count } => {
            mv(*x, *y)?;
            let code = match button {
                Button::Left => "0xC0",
                Button::Right => "0xC1",
                Button::Middle => "0xC2",
            };
            ydo_run(&s(&["click", "--repeat", &count.to_string(), "--next-delay", "70", code]))
        }
        Input::Drag { from, to } => {
            mv(from.0, from.1)?;
            ydo_run(&s(&["click", "0x40"]))?;
            let r = mv(to.0, to.1);
            ydo_run(&s(&["click", "0x80"]))?;
            r
        }
        Input::Scroll { x, y, dx, dy } => {
            mv(*x, *y)?;
            ydo_run(&s(&["mousemove", "--wheel", "-x", &dx.to_string(), "-y", &(-dy).to_string()]))
        }
        Input::Text(t) => ydo_run(&s(&["type", "--", t])),
        Input::Keys(keys) => {
            let codes: Vec<u16> = keys.iter().map(|k| evdev(*k).ok_or_else(|| "Diese Taste kann ydotool nicht senden.".to_string())).collect::<CmdResult<_>>()?;
            let mut args = vec!["key".to_string()];
            args.extend(codes.iter().map(|c| format!("{c}:1")));
            args.extend(codes.iter().rev().map(|c| format!("{c}:0")));
            ydo_run(&args)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(uri_path("file:///home/a/Bilder/Bildschirmfoto%20vom%202026.png").unwrap(), std::path::PathBuf::from("/home/a/Bilder/Bildschirmfoto vom 2026.png"));
        assert!(uri_path("https://x").is_none());
    }

    #[test]
    fn locates_points_on_hidpi_layout() {
        // Zwei Bildschirme logisch nebeneinander (je 1280×800), Screenshot doppelt so groß.
        let streams = vec![StreamGeo { node: 1, x: 0.0, y: 0.0, w: 1280.0, h: 800.0 }, StreamGeo { node: 2, x: 1280.0, y: 0.0, w: 1280.0, h: 800.0 }];
        *LAST.lock().unwrap() = (5120, 1600);
        assert_eq!(locate(&streams, 200.0, 100.0, false).unwrap(), (1, 100.0, 50.0));
        assert_eq!(locate(&streams, 2760.0, 400.0, false).unwrap(), (2, 100.0, 200.0));
        // Mutter: Position im Stream in Bildschirmpixeln.
        assert_eq!(locate(&streams, 2760.0, 400.0, true).unwrap(), (2, 200.0, 400.0));

        // GNOME mit 125 %: 3840×2160 Pixel, logisch 3072×1728 (gemessen auf Fedora 44).
        let streams = vec![StreamGeo { node: 7, x: 0.0, y: 0.0, w: 3072.0, h: 1728.0 }];
        *LAST.lock().unwrap() = (3840, 2160);
        assert_eq!(locate(&streams, 2961.0, 1098.0, true).unwrap(), (7, 2961.0, 1098.0));
        assert_eq!(locate(&streams, 2960.0, 1100.0, false).unwrap(), (7, 2368.0, 880.0));
    }

    #[test]
    fn evdev_codes() {
        use crate::computer::keys::Key;
        assert_eq!(evdev(Key::Char('a')), Some(30));
        assert_eq!(evdev(Key::Char('0')), Some(11));
        assert_eq!(evdev(Key::F(12)), Some(88));
    }
}
