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

## Betrieb mit Docker

```bash
docker build -t brise-relay relay/
docker run -d --name brise-relay --restart unless-stopped -p 8787:8787 brise-relay
```

Oder als Stack (`compose.yaml`):

```yaml
services:
  brise-relay:
    build: ./relay
    image: brise-relay
    restart: unless-stopped
    ports:
      - "8787:8787"
    # Kein Volume nötig: das Relay speichert nichts.
```

Das Image enthält einen Healthcheck (`brise-relay --healthcheck`).

## Hinter einem Reverse-Proxy mit TLS

Gäste außerhalb des LANs sollten `wss://` nutzen. Beispiel Caddy:

```
relay.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

Beispiel nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

In Brise dann unter Einstellungen → Zusammenarbeit die Relay-Adresse
`wss://relay.example.org` eintragen. Sie landet im Einladungslink.

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
