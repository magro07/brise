//! Verschlüsselung und Signaturen der Kollaboration (siehe docs/collab-protocol.md).
//!
//! Jeder Frame: 24 Byte Nonce ‖ XChaCha20-Poly1305(Raumschlüssel, Umschlag),
//! zusätzlich authentifiziert mit `brise-collab-v1:<raum>`. Der Umschlag trägt
//! Absender (Ed25519-Schlüssel), Signatur und die eigentliche Nachricht.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DOMAIN: &str = "brise-collab-v1";

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("Zufallsquelle des Systems nicht verfügbar");
    out
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64<const N: usize>(text: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(text.trim()).ok()?.try_into().ok()
}

/// Eigene Identität: Ed25519-Schlüssel (dauerhaft, siehe secrets.rs).
#[derive(Clone)]
pub struct Identity(SigningKey);

impl Identity {
    pub fn generate() -> Self {
        Self::from_seed(random::<32>())
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }

    pub fn seed(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    /// Signatur über beliebige Bytes (base64url), z. B. für den Team-Stand.
    pub fn sign(&self, msg: &[u8]) -> String {
        b64(&self.0.sign(msg).to_bytes())
    }

    /// Öffentlicher Schlüssel als Teilnehmer-ID.
    pub fn id(&self) -> String {
        b64(self.0.verifying_key().as_bytes())
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    from: String,
    sig: String,
    body: String,
}

fn signed_bytes(room: &str, body: &str) -> Vec<u8> {
    format!("{DOMAIN}:{room}:{body}").into_bytes()
}

/// Signiert, verpackt und verschlüsselt eine Nachricht.
pub fn seal(key: &[u8; 32], room: &str, me: &Identity, body: &Value) -> Vec<u8> {
    let body = body.to_string();
    let sig = me.0.sign(&signed_bytes(room, &body));
    let envelope = serde_json::to_vec(&Envelope { from: me.id(), sig: b64(&sig.to_bytes()), body }).unwrap_or_default();
    let nonce = random::<24>();
    let cipher = XChaCha20Poly1305::new(&Key::from(*key));
    let aad = format!("{DOMAIN}:{room}");
    let mut frame = nonce.to_vec();
    match cipher.encrypt(&XNonce::from(nonce), Payload { msg: &envelope, aad: aad.as_bytes() }) {
        Ok(ct) => frame.extend(ct),
        Err(_) => frame.clear(),
    }
    frame
}

/// Entschlüsselt einen Frame und prüft die Signatur. Liefert Absender und Nachricht.
pub fn open(key: &[u8; 32], room: &str, frame: &[u8]) -> Option<(String, Value)> {
    if frame.len() < 24 + 16 {
        return None;
    }
    let (nonce, ct) = frame.split_at(24);
    let nonce: [u8; 24] = nonce.try_into().ok()?;
    let cipher = XChaCha20Poly1305::new(&Key::from(*key));
    let aad = format!("{DOMAIN}:{room}");
    let plain = cipher.decrypt(&XNonce::from(nonce), Payload { msg: ct, aad: aad.as_bytes() }).ok()?;
    let env: Envelope = serde_json::from_slice(&plain).ok()?;
    let from = VerifyingKey::from_bytes(&unb64::<32>(&env.from)?).ok()?;
    let sig = Signature::from_bytes(&unb64::<64>(&env.sig)?);
    from.verify_strict(&signed_bytes(room, &env.body), &sig).ok()?;
    Some((env.from, serde_json::from_str(&env.body).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_and_tamper() {
        let key = random::<32>();
        let me = Identity::generate();
        let frame = seal(&key, "raum-123456789012", &me, &json!({ "t": "hello" }));
        let (from, body) = open(&key, "raum-123456789012", &frame).unwrap();
        assert_eq!(from, me.id());
        assert_eq!(body["t"], "hello");
        // Anderer Raum, anderer Schlüssel, verändertes Byte: alles abgelehnt.
        assert!(open(&key, "raum-anderer-00000", &frame).is_none());
        assert!(open(&random::<32>(), "raum-123456789012", &frame).is_none());
        let mut bad = frame.clone();
        bad[30] ^= 1;
        assert!(open(&key, "raum-123456789012", &bad).is_none());
    }
}
