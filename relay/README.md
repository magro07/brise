# brise-relay

Kleiner Relay-Dienst für Brises Kollaboration (geteilte Sessions). Er verbindet
Host und Gäste über WebSocket und leitet nur verschlüsselte Frames weiter. Er
kennt weder Schlüssel noch Inhalte und speichert nichts auf Platte. Protokoll:
[`docs/collab-protocol.md`](../docs/collab-protocol.md).

Im selben Netz braucht es kein Relay: Brise bietet den WebSocket dann selbst an
(Einstellungen → Zusammenarbeit → „Direkt im LAN“). Das Relay ist für Gäste von
außerhalb gedacht, z. B. im eigenen Homelab.

## Endpunkte

| Pfad | |
|---|---|
| `GET /ws/<raum>` | WebSocket. Binär-Frames gehen an alle anderen im Raum. |
| `GET /healthz` | `{"status":"ok","rooms":…,"connections":…}` |

## Konfiguration

| Variable | Standard | |
|---|---|---|
| `BRISE_RELAY_ADDR` | `0.0.0.0:8787` | Adresse und Port |
| `BRISE_RELAY_BUFFER` | `256` | Frames je Raum für Nachzügler, `0` schaltet den Puffer ab |
| `BRISE_RELAY_BUFFER_BYTES` | `16777216` | Obergrenze des Puffers je Raum |
| `BRISE_RELAY_MAX_FRAME` | `8388608` | größter Frame (Snapshots langer Sessions) |
| `BRISE_RELAY_MAX_ROOMS` | `1000` | |
| `BRISE_RELAY_MAX_MEMBERS` | `32` | Teilnehmer je Raum |
| `BRISE_RELAY_ROOM_TTL` | `600` | Sekunden, die ein leerer Raum samt Puffer erhalten bleibt |

## Betrieb im Homelab

Fertige Dateien liegen in [`deploy/`](deploy/). Drei Wege, vom sichersten zum offensten:

### A. Nur LAN oder VPN (empfohlen für einen kleinen Freundeskreis)

Das Relay ist nur im eigenen Netz erreichbar. Freunde von außen kommen über ein
VPN herein (z. B. WireGuard der FritzBox oder Tailscale) und nutzen dieselbe Adresse.
Es wird kein Port ins Internet geöffnet.

```bash
cd relay/deploy
docker compose -f compose.lan.yaml up -d --build
curl http://<docker-host>:8787/healthz
```

In Brise unter Einstellungen → Zusammenarbeit: „Über Relay“, Adresse
`ws://<docker-host>:8787`. Die Inhalte sind trotzdem Ende-zu-Ende verschlüsselt,
TLS ist hier nicht zwingend.

### B. Öffentlich mit Caddy und automatischem TLS

1. DNS: `relay.example.org` zeigt auf die öffentliche IP (bei wechselnder IP per DynDNS).
2. Router: Ports 80 und 443 auf den Docker-Host weiterleiten (80 braucht Let's Encrypt).
3. Starten:

   ```bash
   cd relay/deploy
   echo "RELAY_DOMAIN=relay.example.org" > .env
   docker compose up -d --build
   curl https://relay.example.org/healthz
   ```

4. In Brise: Relay-Adresse `wss://relay.example.org`.

Caddy holt und erneuert das Zertifikat selbst und leitet nur `/ws/*` und
`/healthz` an das Relay weiter. Das Relay selbst hat keinen offenen Port.

### C. Hinter einem vorhandenen Reverse-Proxy

Nur den Dienst `brise-relay` aus `compose.lan.yaml` starten (Port ggf. nur an
`127.0.0.1` binden) und im Proxy WebSockets durchreichen. nginx:

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
location = /healthz { proxy_pass http://127.0.0.1:8787; }
```

Caddy: `reverse_proxy 127.0.0.1:8787` (WebSockets gehen automatisch durch).
Nginx Proxy Manager: Host anlegen, „Websockets Support“ einschalten.

### Betrieb

- **Updates:** `git pull && docker compose up -d --build` im Ordner `relay/deploy`.
- **Überwachen:** `GET /healthz` (z. B. in Uptime Kuma als HTTP-Monitor), das Image
  bringt einen Docker-Healthcheck mit.
- **Backup:** nicht nötig, das Relay hat keinen Zustand. Bei Caddy das Volume
  `caddy-data` (Zertifikate) mitsichern, verloren ist es aber auch nicht schlimm.
- **Logs:** `docker compose logs -f brise-relay` – ohne Raum-IDs oder Inhalte.
- **Rate-Limits:** für öffentliche Erreichbarkeit im Proxy setzen (z. B. Verbindungen je IP).

## Ohne Docker

```bash
cd relay
cargo build --release
BRISE_RELAY_ADDR=0.0.0.0:8787 ./target/release/brise-relay
```

## Sicherheit

- Inhalte sind mit XChaCha20-Poly1305 verschlüsselt, der Schlüssel steht nur im
  Fragment des Einladungslinks und erreicht das Relay nie.
- Raum-IDs sind 128 Bit zufällig. Wer sie kennt, sieht trotzdem nur Chiffretext.
- Das Relay loggt keine Raum-IDs oder Inhalte.
- Grenzen für Räume, Teilnehmer und Frame-Größe schützen vor Missbrauch. Für
  öffentliche Erreichbarkeit zusätzlich Rate-Limits im Reverse-Proxy setzen.
