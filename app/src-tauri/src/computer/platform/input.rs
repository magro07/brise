//! Eingaben über enigo: XTest unter X11, CGEvent unter macOS, SendInput unter Windows.

use std::thread::sleep;
use std::time::Duration;

use enigo::{Axis, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use super::{Button, Input};
use crate::computer::keys::Key;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("Eingabe fehlgeschlagen: {e}")
}

fn button(b: Button) -> enigo::Button {
    match b {
        Button::Left => enigo::Button::Left,
        Button::Right => enigo::Button::Right,
        Button::Middle => enigo::Button::Middle,
    }
}

fn key(k: Key) -> CmdResult<enigo::Key> {
    use enigo::Key as E;
    Ok(match k {
        Key::Ctrl => E::Control,
        Key::Shift => E::Shift,
        Key::Alt => E::Alt,
        Key::Meta => E::Meta,
        Key::Return => E::Return,
        Key::Escape => E::Escape,
        Key::Tab => E::Tab,
        Key::Backspace => E::Backspace,
        Key::Delete => E::Delete,
        #[cfg(not(target_os = "macos"))]
        Key::Insert => E::Insert,
        #[cfg(target_os = "macos")]
        Key::Insert => return Err("Die Einfügen-Taste gibt es unter macOS nicht.".into()),
        Key::Home => E::Home,
        Key::End => E::End,
        Key::PageUp => E::PageUp,
        Key::PageDown => E::PageDown,
        Key::Left => E::LeftArrow,
        Key::Right => E::RightArrow,
        Key::Up => E::UpArrow,
        Key::Down => E::DownArrow,
        Key::Space => E::Space,
        Key::F(n) => match n {
            1 => E::F1,
            2 => E::F2,
            3 => E::F3,
            4 => E::F4,
            5 => E::F5,
            6 => E::F6,
            7 => E::F7,
            8 => E::F8,
            9 => E::F9,
            10 => E::F10,
            11 => E::F11,
            12 => E::F12,
            _ => return Err(format!("F{n} wird nicht unterstützt.")),
        },
        Key::Char(c) => E::Unicode(c),
    })
}

fn at(e: &mut Enigo, x: f64, y: f64) -> CmdResult<()> {
    e.move_mouse(x.round() as i32, y.round() as i32, Coordinate::Abs).map_err(err)?;
    sleep(Duration::from_millis(40));
    Ok(())
}

pub fn run(a: &Input) -> CmdResult<()> {
    let mut e = Enigo::new(&Settings::default()).map_err(|e| format!("Eingabe nicht verfügbar: {e}"))?;
    match a {
        Input::Move { x, y } => at(&mut e, *x, *y),
        Input::Click { x, y, button: b, count } => {
            at(&mut e, *x, *y)?;
            for i in 0..*count {
                if i > 0 {
                    sleep(Duration::from_millis(70));
                }
                e.button(button(*b), Direction::Click).map_err(err)?;
            }
            Ok(())
        }
        Input::Drag { from, to } => {
            at(&mut e, from.0, from.1)?;
            e.button(enigo::Button::Left, Direction::Press).map_err(err)?;
            // In Schritten ziehen, damit Programme die Bewegung mitbekommen.
            let steps = 12;
            let mut result = Ok(());
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                if let Err(x) = at(&mut e, from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t) {
                    result = Err(x);
                    break;
                }
            }
            e.button(enigo::Button::Left, Direction::Release).map_err(err)?;
            result
        }
        Input::Scroll { x, y, dx, dy } => {
            at(&mut e, *x, *y)?;
            if *dy != 0 {
                e.scroll(*dy, Axis::Vertical).map_err(err)?;
            }
            if *dx != 0 {
                e.scroll(*dx, Axis::Horizontal).map_err(err)?;
            }
            Ok(())
        }
        Input::Text(t) => e.text(t).map_err(err),
        Input::Keys(keys) => {
            let mapped: Vec<enigo::Key> = keys.iter().map(|k| key(*k)).collect::<CmdResult<_>>()?;
            let (last, mods) = mapped.split_last().ok_or("Keine Taste angegeben")?;
            for m in mods {
                e.key(*m, Direction::Press).map_err(err)?;
            }
            let r = e.key(*last, Direction::Click).map_err(err);
            for m in mods.iter().rev() {
                let _ = e.key(*m, Direction::Release);
            }
            r
        }
    }
}
