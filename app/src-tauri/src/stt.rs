//! Lokale Spracheingabe: Brise nimmt selbst auf und schickt das Audio an einen
//! OpenAI-kompatiblen Transkriptionsserver des Nutzers. Nichts wird gespeichert.

use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct Recorder {
    stop: Mutex<Option<mpsc::Sender<()>>>,
    audio: Arc<Mutex<Vec<f32>>>,
    format: Arc<Mutex<(u32, u16)>>,
}

/// Mono-Mittel je Frame; die Pegelanzeige bekommt den Spitzenwert.
fn push(audio: &Mutex<Vec<f32>>, app: &AppHandle, last: &mut Instant, channels: usize, data: impl Iterator<Item = f32>) {
    let samples: Vec<f32> = data.collect();
    let mono: Vec<f32> = samples.chunks(channels.max(1)).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect();
    if last.elapsed() >= Duration::from_millis(33) {
        let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len().max(1) as f32).sqrt();
        let _ = app.emit("voice:level", json!({ "level": (rms * 6.0).sqrt().min(1.0) }));
        *last = Instant::now();
    }
    if let Ok(mut a) = audio.lock() {
        a.extend(mono);
    }
}

#[tauri::command]
pub fn stt_start(app: AppHandle, rec: State<'_, Recorder>) -> CmdResult<()> {
    let _ = stt_cancel(rec.clone());
    let (tx, rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let audio = rec.audio.clone();
    let format = rec.format.clone();
    // Streams sind nicht auf allen Systemen Send – eigener Thread.
    std::thread::spawn(move || {
        let result = (|| -> Result<cpal::Stream, String> {
            let device = cpal::default_host().default_input_device().ok_or("Kein Mikrofon gefunden")?;
            let config = device.default_input_config().map_err(|e| e.to_string())?;
            let channels = config.channels() as usize;
            *format.lock().map_err(|e| e.to_string())? = (config.sample_rate().0, 1);
            let err = |e| eprintln!("Mikrofon: {e}");
            let mut last = Instant::now();
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| push(&audio, &app, &mut last, channels, d.iter().copied()), err, None),
                cpal::SampleFormat::I16 => device.build_input_stream(&config.into(), move |d: &[i16], _: &_| push(&audio, &app, &mut last, channels, d.iter().map(|s| *s as f32 / 32768.0)), err, None),
                cpal::SampleFormat::U16 => device.build_input_stream(&config.into(), move |d: &[u16], _: &_| push(&audio, &app, &mut last, channels, d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0)), err, None),
                other => return Err(format!("Audioformat {other:?} wird nicht unterstützt")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(stream)
        })();
        match result {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                let _ = rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())??;
    *rec.stop.lock().map_err(|e| e.to_string())? = Some(tx);
    Ok(())
}

#[tauri::command]
pub fn stt_cancel(rec: State<'_, Recorder>) -> CmdResult<()> {
    rec.stop.lock().map_err(|e| e.to_string())?.take();
    rec.audio.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let size = samples.len() as u32 * 2;
    let mut out = Vec::with_capacity(44 + size as usize);
    out.extend(b"RIFF");
    out.extend((36 + size).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(size.to_le_bytes());
    for s in samples {
        out.extend(((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

fn multipart(boundary: &str, audio: &[u8], model: &str, language: &str) -> Vec<u8> {
    let mut b = Vec::with_capacity(audio.len() + 512);
    for (k, v) in [("model", model), ("language", language), ("response_format", "json")] {
        if !v.is_empty() {
            b.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
        }
    }
    b.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    b.extend(audio);
    b.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    b
}

fn base(endpoint: &str) -> String {
    endpoint.trim_end_matches('/').trim_end_matches("/audio/transcriptions").to_string()
}

#[tauri::command]
pub async fn stt_stop(rec: State<'_, Recorder>, endpoint: String, model: String, language: String) -> CmdResult<String> {
    rec.stop.lock().map_err(|e| e.to_string())?.take();
    let samples = std::mem::take(&mut *rec.audio.lock().map_err(|e| e.to_string())?);
    let rate = rec.format.lock().map_err(|e| e.to_string())?.0;
    if samples.is_empty() {
        return Ok(String::new());
    }
    let boundary = "brise-stt-boundary";
    let resp = reqwest::Client::new()
        .post(format!("{}/audio/transcriptions", base(&endpoint)))
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(multipart(boundary, &wav(&samples, rate), &model, &language))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("Transkriptionsserver nicht erreichbar: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Transkriptionsserver meldet {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["text"].as_str().unwrap_or_default().trim().to_string())
}

/// Antwortet dort überhaupt ein Server? Auch 404 oder 405 zählen als erreichbar.
#[tauri::command]
pub async fn stt_check(endpoint: String) -> CmdResult<()> {
    reqwest::Client::new().get(base(&endpoint)).timeout(Duration::from_secs(5)).send().await.map(|_| ()).map_err(|e| format!("Nicht erreichbar: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_passt_zur_laenge() {
        let w = wav(&[0.0, 1.0], 16000);
        assert_eq!(w.len(), 48);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes([w[40], w[41], w[42], w[43]]), 4);
    }

    #[test]
    fn adresse_wird_vereinheitlicht() {
        assert_eq!(base("http://x:8080/v1/audio/transcriptions"), "http://x:8080/v1");
        assert_eq!(base("http://x:8080/v1/"), "http://x:8080/v1");
    }
}
