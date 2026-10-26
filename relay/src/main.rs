//! `brise-relay` – eigenständiger Relay-Dienst für Brises Kollaboration.
//!
//! `brise-relay` startet den Dienst (Adresse aus `BRISE_RELAY_ADDR`),
//! `brise-relay --healthcheck` prüft einen laufenden Dienst (für Docker).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn addr() -> String {
    std::env::var("BRISE_RELAY_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".into())
}

/// Fragt `/healthz` per einfachem HTTP ab, ohne curl im Image.
fn healthcheck() -> i32 {
    let port = addr().rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(8787);
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    let check = || -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&target, Duration::from_secs(3))?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut out = String::new();
        s.read_to_string(&mut out)?;
        Ok(out.starts_with("HTTP/1.1 200"))
    };
    match check() {
        Ok(true) => 0,
        _ => 1,
    }
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--healthcheck") {
        std::process::exit(healthcheck());
    }
    let cfg = brise_relay::Config::from_env();
    let addr = addr();
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("brise-relay: {addr} nicht verfügbar: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "brise-relay {} lauscht auf {addr} (Puffer {} Frames, max. Frame {} KiB)",
        env!("CARGO_PKG_VERSION"),
        cfg.buffer,
        cfg.max_frame / 1024
    );
    let app = brise_relay::router(cfg);
    if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(shutdown()).await {
        eprintln!("brise-relay: {e}");
        std::process::exit(1);
    }
}
