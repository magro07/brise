//! macOS und Windows: Bildschirm und Fenster über xcap (ScreenCaptureKit/
//! CGWindowList bzw. GDI/DXGI), dazu Fokus, Rechte und Passwort-Erkennung
//! über die Systemschnittstellen.

use super::{Caps, Rect, Shot, WinInfo};

type CmdResult<T> = Result<T, String>;

fn e(err: impl std::fmt::Display) -> String {
    format!("Bildschirm: {err}")
}

pub fn capture(monitor: Option<usize>) -> CmdResult<Shot> {
    #[cfg(target_os = "macos")]
    if !mac::screen_allowed() {
        return Err("macOS hat die Bildschirmaufnahme für Brise noch nicht erlaubt: Systemeinstellungen → Datenschutz & Sicherheit → \
            Bildschirm- und Systemaudioaufnahme → Brise einschalten (Einstellungen → Werkzeuge → Computer Use → Rechte anfragen)."
            .into());
    }
    let monitors = xcap::Monitor::all().map_err(e)?;
    let m = match monitor {
        Some(i) => monitors.get(i).ok_or_else(|| format!("Bildschirm {i} gibt es nicht ({} vorhanden).", monitors.len()))?,
        None => monitors.iter().find(|m| m.is_primary().unwrap_or(false)).or(monitors.first()).ok_or("Kein Bildschirm gefunden")?,
    };
    let img = m.capture_image().map_err(e)?;
    let width = m.width().map_err(e)?.max(1);
    Ok(Shot { unit: img.width() as f64 / width as f64, ox: m.x().map_err(e)? as f64, oy: m.y().map_err(e)? as f64, img })
}

pub fn windows() -> CmdResult<Vec<WinInfo>> {
    let me = std::process::id();
    let mut out = Vec::new();
    for w in xcap::Window::all().map_err(e)? {
        let title = w.title().unwrap_or_default();
        let app = w.app_name().unwrap_or_default();
        if title.is_empty() && app.is_empty() {
            continue;
        }
        let (Ok(x), Ok(y), Ok(wd), Ok(ht)) = (w.x(), w.y(), w.width(), w.height()) else { continue };
        if wd < 2 || ht < 2 {
            continue;
        }
        out.push(WinInfo {
            id: w.id().map_err(e)? as u64,
            title: if title.is_empty() { app.clone() } else { title },
            app,
            rect: Rect { x: x as f64, y: y as f64, w: wd as f64, h: ht as f64 },
            focused: w.is_focused().unwrap_or(false),
            minimized: w.is_minimized().unwrap_or(false),
            brise: w.pid().ok() == Some(me),
        });
    }
    Ok(out)
}

pub fn focus(id: u64) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        win::focus(id)
    }
    #[cfg(target_os = "macos")]
    {
        // Programm aktivieren; macOS holt dabei sein vorderstes Fenster nach vorn.
        let w = xcap::Window::all().map_err(e)?.into_iter().find(|w| w.id().ok() == Some(id as u32)).ok_or("Fenster nicht mehr vorhanden")?;
        let app = w.app_name().map_err(e)?;
        let ok = std::process::Command::new("open").args(["-a", &app]).status().map_err(|x| x.to_string())?.success();
        if !ok {
            return Err(format!("„{app}“ ließ sich nicht aktivieren."));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        Ok(())
    }
}

fn focused_title() -> Option<String> {
    xcap::Window::all().ok()?.into_iter().find(|w| w.is_focused().unwrap_or(false)).and_then(|w| w.title().ok())
}

pub fn password_context() -> CmdResult<Option<String>> {
    #[cfg(target_os = "macos")]
    if mac::secure_input() {
        return Ok(Some("macOS meldet eine sichere Texteingabe (Passwortfeld).".into()));
    }
    #[cfg(target_os = "windows")]
    if win::password_focused() {
        return Ok(Some("Der Fokus liegt auf einem Passwortfeld.".into()));
    }
    Ok(focused_title().and_then(|t| super::password_title(&t)))
}

pub fn capabilities() -> Caps {
    let mut caps = Caps { backend: if cfg!(target_os = "macos") { "macos" } else { "windows" }.into(), windows: true, ..Default::default() };
    let monitors = xcap::Monitor::all().map(|m| m.len()).unwrap_or(0);
    #[cfg(target_os = "macos")]
    {
        caps.screenshot = mac::screen_allowed();
        caps.screenshot_detail = if caps.screenshot {
            format!("Bildschirmaufnahme erlaubt ({monitors} Bildschirm(e))")
        } else {
            "Bildschirmaufnahme noch nicht erlaubt (Datenschutz & Sicherheit)".into()
        };
        caps.input = mac::input_allowed();
        caps.input_detail = if caps.input { "Bedienungshilfen erlaubt (CGEvent)".into() } else { "Bedienungshilfen noch nicht erlaubt (Datenschutz & Sicherheit)".into() };
    }
    #[cfg(target_os = "windows")]
    {
        caps.screenshot = monitors > 0;
        caps.screenshot_detail = format!("{monitors} Bildschirm(e) über GDI/DXGI");
        caps.input = true;
        caps.input_detail = "SendInput".into();
        caps.notes.push("Fenster mit Administratorrechten nehmen keine Eingaben von Brise an (UIPI).".into());
    }
    caps
}

#[cfg(target_os = "macos")]
pub fn request_access() -> CmdResult<String> {
    let screen = mac::screen_allowed() || mac::request_screen();
    let input = mac::input_allowed();
    if !input {
        let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status();
    }
    Ok(match (screen, input) {
        (true, true) => "Bildschirmaufnahme und Bedienungshilfen sind erlaubt.".into(),
        (false, true) => "Bitte in den Systemeinstellungen die Bildschirmaufnahme für Brise erlauben und Brise neu starten.".into(),
        (true, false) => "Bitte in den Systemeinstellungen unter Bedienungshilfen Brise einschalten.".into(),
        (false, false) => "Bitte Bildschirmaufnahme und Bedienungshilfen für Brise erlauben (Systemeinstellungen → Datenschutz & Sicherheit).".into(),
    })
}

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn IsSecureEventInputEnabled() -> u8;
    }

    pub fn screen_allowed() -> bool {
        // SAFETY: parameterlose Abfragen ohne Nebenwirkungen.
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub fn request_screen() -> bool {
        // SAFETY: zeigt höchstens die Systemabfrage.
        unsafe { CGRequestScreenCaptureAccess() }
    }
    pub fn input_allowed() -> bool {
        // SAFETY: parameterlose Abfrage.
        unsafe { AXIsProcessTrusted() }
    }
    pub fn secure_input() -> bool {
        // SAFETY: parameterlose Abfrage.
        unsafe { IsSecureEventInputEnabled() != 0 }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongW, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, GUITHREADINFO,
        GWL_STYLE, SW_RESTORE,
    };

    /// Stil-Bit von Edit-Steuerelementen für Passwortfelder.
    const ES_PASSWORD: i32 = 0x20;

    pub fn focus(id: u64) -> Result<(), String> {
        let hwnd = HWND(id as usize as *mut core::ffi::c_void);
        // SAFETY: Fensterhandle aus der Fensterliste; ungültige Handles lehnt Windows ab.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if !SetForegroundWindow(hwnd).as_bool() {
                return Err("Windows hat das Fenster nicht nach vorn geholt (Fokus-Sperre). Klicke stattdessen hinein.".into());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(())
    }

    pub fn password_focused() -> bool {
        // SAFETY: nur lesende Abfragen auf Handles des Vordergrundfensters.
        unsafe {
            let fg = GetForegroundWindow();
            let thread = GetWindowThreadProcessId(fg, None);
            let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            if GetGUIThreadInfo(thread, &mut info).is_err() || info.hwndFocus.0.is_null() {
                return false;
            }
            let mut class = [0u16; 64];
            let n = GetClassNameW(info.hwndFocus, &mut class);
            let name = String::from_utf16_lossy(&class[..n.max(0) as usize]).to_lowercase();
            name.contains("edit") && GetWindowLongW(info.hwndFocus, GWL_STYLE) & ES_PASSWORD != 0
        }
    }
}
