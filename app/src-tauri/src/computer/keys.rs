//! Tastennamen aus `computer_key` („ctrl+shift+t“, „Return“, „alt+F4“) in
//! eine plattformneutrale Form bringen; die Plattformen übersetzen weiter.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Ctrl,
    Shift,
    Alt,
    /// Super-, Windows- bzw. Befehlstaste.
    Meta,
    Return,
    Escape,
    Tab,
    Backspace,
    Delete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Left,
    Right,
    Up,
    Down,
    Space,
    F(u8),
    Char(char),
}

pub fn parse(combo: &str) -> Result<Vec<Key>, String> {
    if combo.trim() == "+" {
        return Ok(vec![Key::Char('+')]);
    }
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err(format!("Ungültige Tastenkombination „{combo}“"));
    }
    parts.iter().map(|p| one(p).ok_or_else(|| format!("Unbekannte Taste „{p}“ in „{combo}“"))).collect()
}

fn one(name: &str) -> Option<Key> {
    let lower = name.to_lowercase();
    Some(match lower.as_str() {
        "ctrl" | "control" | "strg" | "control_l" | "ctrl_l" => Key::Ctrl,
        "shift" | "shift_l" | "umschalt" => Key::Shift,
        "alt" | "alt_l" | "option" | "opt" => Key::Alt,
        "super" | "super_l" | "meta" | "win" | "windows" | "cmd" | "command" => Key::Meta,
        "return" | "enter" | "kp_enter" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "backspace" | "back_space" => Key::Backspace,
        "delete" | "del" | "entf" => Key::Delete,
        "insert" | "ins" | "einfg" => Key::Insert,
        "home" | "pos1" => Key::Home,
        "end" | "ende" => Key::End,
        "page_up" | "pageup" | "prior" | "bild_auf" => Key::PageUp,
        "page_down" | "pagedown" | "next" | "bild_ab" => Key::PageDown,
        "left" | "arrowleft" => Key::Left,
        "right" | "arrowright" => Key::Right,
        "up" | "arrowup" => Key::Up,
        "down" | "arrowdown" => Key::Down,
        "space" | "leertaste" => Key::Space,
        "minus" => Key::Char('-'),
        "plus" => Key::Char('+'),
        "period" => Key::Char('.'),
        "comma" => Key::Char(','),
        "slash" => Key::Char('/'),
        _ => {
            if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=24).contains(n)) {
                return Some(Key::F(n));
            }
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            // Mit Strg & Co. ist „T“ dieselbe Taste wie „t“.
            Key::Char(c.to_lowercase().next().unwrap_or(c))
        }
    })
}

/// X11-Keysym (für das RemoteDesktop-Portal unter Wayland).
pub fn keysym(k: Key) -> u32 {
    match k {
        Key::Ctrl => 0xffe3,
        Key::Shift => 0xffe1,
        Key::Alt => 0xffe9,
        Key::Meta => 0xffeb,
        Key::Return => 0xff0d,
        Key::Escape => 0xff1b,
        Key::Tab => 0xff09,
        Key::Backspace => 0xff08,
        Key::Delete => 0xffff,
        Key::Insert => 0xff63,
        Key::Home => 0xff50,
        Key::End => 0xff57,
        Key::PageUp => 0xff55,
        Key::PageDown => 0xff56,
        Key::Left => 0xff51,
        Key::Up => 0xff52,
        Key::Right => 0xff53,
        Key::Down => 0xff54,
        Key::Space => 0x20,
        Key::F(n) => 0xffbe + n as u32 - 1,
        Key::Char(c) => char_keysym(c),
    }
}

/// Keysym eines Zeichens: Latin-1 direkt, alles andere über Unicode-Keysyms.
pub fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        c if (' '..='~').contains(&c) || ('\u{a0}'..='\u{ff}').contains(&c) => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_combos() {
        assert_eq!(parse("ctrl+shift+T").unwrap(), vec![Key::Ctrl, Key::Shift, Key::Char('t')]);
        assert_eq!(parse("Return").unwrap(), vec![Key::Return]);
        assert_eq!(parse("alt+F4").unwrap(), vec![Key::Alt, Key::F(4)]);
        assert_eq!(parse("cmd+c").unwrap(), vec![Key::Meta, Key::Char('c')]);
        assert_eq!(parse("+").unwrap(), vec![Key::Char('+')]);
        assert!(parse("ctrl+").is_err());
        assert!(parse("hyperdrive").is_err());
    }

    #[test]
    fn keysyms() {
        assert_eq!(keysym(Key::Return), 0xff0d);
        assert_eq!(keysym(Key::F(1)), 0xffbe);
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('ä'), 0xe4);
        assert_eq!(char_keysym('€'), 0x0100_20ac);
    }
}
