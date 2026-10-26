//! WebSocket-Verbindung zum Relay mit automatischem Neuverbinden.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub struct Transport {
    out: mpsc::UnboundedSender<Vec<u8>>,
}

impl Transport {
    /// Verbindet mit `url` und hält die Verbindung, bis der Transport fallen
    /// gelassen wird. Ausstehende Frames werden dann noch verschickt.
    pub fn spawn(
        url: String,
        on_frame: impl Fn(Vec<u8>) + Send + 'static,
        on_status: impl Fn(bool, Option<String>) + Send + 'static,
    ) -> Self {
        let (out, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tauri::async_runtime::spawn(async move {
            let mut delay = 1;
            loop {
                match tokio_tungstenite::connect_async(url.as_str()).await {
                    Ok((socket, _)) => {
                        delay = 1;
                        on_status(true, None);
                        let (mut sink, mut stream) = socket.split();
                        loop {
                            tokio::select! {
                                msg = stream.next() => match msg {
                                    Some(Ok(Message::Binary(data))) => on_frame(data.to_vec()),
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    Some(Ok(_)) => {}
                                },
                                frame = rx.recv() => match frame {
                                    Some(frame) => {
                                        if sink.send(Message::Binary(frame.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => {
                                        let _ = sink.close().await;
                                        return;
                                    }
                                },
                            }
                        }
                        on_status(false, Some("Verbindung zum Relay unterbrochen".into()));
                    }
                    Err(e) => on_status(false, Some(format!("Relay nicht erreichbar: {e}"))),
                }
                if rx.is_closed() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(30);
            }
        });
        Self { out }
    }

    pub fn send(&self, frame: Vec<u8>) {
        let _ = self.out.send(frame);
    }
}
