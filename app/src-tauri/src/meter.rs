//! Pegelanzeige für die Spracheingabe. Die eigentliche Aufnahme macht Vibe;
//! Brise misst parallel nur die Lautstärke für die Wellen-Animation und
//! verwirft das Audio sofort – es wird nichts gespeichert oder gesendet.

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct Meter {
    stop: Mutex<Option<mpsc::Sender<()>>>,
}

fn rms<T: Copy>(data: &[T], to_f32: impl Fn(T) -> f32) -> f32 {
    if data.is_empty() {
        return 0.0;
    }
    (data.iter().map(|&s| to_f32(s).powi(2)).sum::<f32>() / data.len() as f32).sqrt()
}

#[tauri::command]
pub fn meter_start(app: AppHandle, meter: State<'_, Meter>) -> CmdResult<()> {
    meter_stop(meter.clone())?;
    let (tx, rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    // Streams sind nicht auf allen Systemen Send – eigener Thread.
    std::thread::spawn(move || {
        let result = (|| -> Result<cpal::Stream, String> {
            let device = cpal::default_host().default_input_device().ok_or("Kein Mikrofon gefunden")?;
            let config = device.default_input_config().map_err(|e| e.to_string())?;
            let mut last = Instant::now();
            let mut peak = 0.0f32;
            let emit_app = app.clone();
            let mut emit = move |level: f32| {
                peak = peak.max(level);
                if last.elapsed() >= Duration::from_millis(33) {
                    // Sprache liegt grob bei 0,01–0,3 RMS; auf 0..1 strecken.
                    let scaled = (peak * 6.0).sqrt().min(1.0);
                    let _ = emit_app.emit("voice:level", json!({ "level": scaled }));
                    peak = 0.0;
                    last = Instant::now();
                }
            };
            let err = |e| eprintln!("Mikrofon: {e}");
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| emit(rms(d, |s| s)), err, None),
                cpal::SampleFormat::I16 => device.build_input_stream(&config.into(), move |d: &[i16], _: &_| emit(rms(d, |s| s as f32 / 32768.0)), err, None),
                cpal::SampleFormat::U16 => device.build_input_stream(&config.into(), move |d: &[u16], _: &_| emit(rms(d, |s| (s as f32 - 32768.0) / 32768.0)), err, None),
                other => return Err(format!("Audioformat {other:?} wird nicht unterstützt")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(stream)
        })();
        match result {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                let _ = rx.recv(); // läuft bis meter_stop
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Mikrofon antwortet nicht".to_string())??;
    *meter.stop.lock().unwrap() = Some(tx);
    Ok(())
}

#[tauri::command]
pub fn meter_stop(meter: State<'_, Meter>) -> CmdResult<()> {
    if let Some(tx) = meter.stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}
