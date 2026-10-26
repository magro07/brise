//! Einladungslinks: `brise://join/<raum>?relay=<url>&exp=<unix>#<schlüssel>.<host>`.
//!
//! Schlüssel und Host-ID stehen im Fragment und gehen nie an das Relay.

use super::crypto::{b64, unb64};

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub room: String,
    pub relay: String,
    pub key: [u8; 32],
    /// Öffentlicher Signaturschlüssel des Hosts (base64url).
    pub host: String,
    /// Ablauf in Unix-Sekunden.
    pub expires: Option<u64>,
}

pub(super) fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(super) fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

impl Link {
    pub fn to_url(&self) -> String {
        let mut url = format!("brise://join/{}?relay={}", self.room, encode(&self.relay));
        if let Some(exp) = self.expires {
            url.push_str(&format!("&exp={exp}"));
        }
        format!("{url}#{}.{}", b64(&self.key), self.host)
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let bad = || "Das ist kein gültiger Brise-Einladungslink.".to_string();
        let rest = text.trim().strip_prefix("brise://join/").ok_or_else(bad)?;
        let (before, fragment) = rest.split_once('#').ok_or("Im Link fehlt der Schlüssel (Teil nach #).")?;
        let (room, query) = before.split_once('?').unwrap_or((before, ""));
        let (key, host) = fragment.split_once('.').ok_or_else(bad)?;
        let key = unb64::<32>(key).ok_or_else(bad)?;
        unb64::<32>(host).ok_or_else(bad)?;
        let mut relay = None;
        let mut expires = None;
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            match pair.split_once('=') {
                Some(("relay", v)) => relay = decode(v),
                Some(("exp", v)) => expires = v.parse().ok(),
                _ => {}
            }
        }
        let relay = relay.ok_or("Im Link fehlt die Relay-Adresse.")?;
        if !(relay.starts_with("ws://") || relay.starts_with("wss://")) {
            return Err("Die Relay-Adresse muss mit ws:// oder wss:// beginnen.".into());
        }
        if room.len() < 16 || !room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(bad());
        }
        Ok(Self { room: room.to_string(), relay, key, host: host.to_string(), expires })
    }

    /// WebSocket-Adresse des Raums auf dem Relay.
    pub fn socket_url(relay: &str, room: &str) -> String {
        format!("{}/ws/{room}", relay.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::crypto::random;

    #[test]
    fn roundtrip() {
        let link = Link {
            room: b64(&random::<16>()),
            relay: "wss://relay.example.org/brise".into(),
            key: random::<32>(),
            host: b64(&random::<32>()),
            expires: Some(1_800_000_000),
        };
        let url = link.to_url();
        assert!(url.starts_with("brise://join/"));
        assert!(!url.split('#').next().unwrap().contains(&b64(&link.key)));
        assert_eq!(Link::parse(&url).unwrap(), link);
        assert!(Link::parse("brise://join/abc#x").is_err());
        assert!(Link::parse(&url.replace("wss%3A", "http%3A")).is_err());
    }
}
