
# Moonbird

Moonbird coordinates Meshtastic/LoRa lunar-path experiments. It combines live radio traffic and experiment rooms with Earth-Moon geometry, pointing data, propagation forecasts, and evidence-based candidate return detection.

<img width="1052" height="1150" alt="Screenshot 2026-06-19 at 1 32 24 PM" src="https://github.com/user-attachments/assets/e5ea7eb6-50ae-4938-93c0-fad1816631ef" />

## Current MVP

- Temporary rooms with unguessable links, required callsigns, and transmitter/receiver/both/observer roles
- Hour, day, week, month, and year forecasts for one station or an overlaid remote station
- Moon azimuth/elevation, range, delay, Doppler, declination, illumination, solar separation, Galactic sky noise, path loss, and relative condition quality
- Three.js Earth-Moon visualization with a sidereal-time-oriented Milky Way star cloud and live propagation graph
- Direct browser HTTP, Bluetooth, or USB Serial connections using the official Meshtastic JavaScript packages
- Optional local companion fallback for unsupported browsers and raw TCP environments
- Complete decoded traffic capture, including ACK/routing, NodeInfo, telemetry, positions, ordinary text, and tagged probes
- FT8-style sequenced CQ, report, Roger, sign-off, and custom messages
- Candidate lunar-return correlation with a prominent visual/audio event
- JSON and CSV exports; traffic is retained for 30 days by default

The shared service never connects to a participant's LAN. Browser radio connections stay local to each participant and forward decoded observations through that participant's authenticated room socket. The optional companion also makes outbound-only connections; its transmit control is disabled unless started with `--allow-transmit`.

## Run locally

Requires Python 3.11+, Node.js 18+, and npm.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
npm run build
.venv/bin/uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open `http://127.0.0.1:8000`.

Or run the shared service with Docker:

```sh
docker compose up --build
```

## Connect a local radio

Create or join a room, then choose a connection in **Radio Control**:

| Connection | Use when | How it connects |
| --- | --- | --- |
| **Wi-Fi / HTTP** | The node's HTTP API is reachable from the browser | Enter the node hostname or IP and select **Connect in browser** |
| **Bluetooth** | The computer supports Web Bluetooth | Select **Connect in browser** and approve the browser's device prompt |
| **USB Serial** | The node is connected by USB | Select **Connect in browser** and choose the node's serial port |
| **Raw TCP** | The node exposes Meshtastic TCP, or browser device APIs are unavailable | Run the terminal companion shown in **Terminal companion fallback** |

Browser Bluetooth and Serial require a supported browser and a secure context (`https://` or localhost). Browsers cannot open raw TCP sockets. All browser connections remain local to the participant's computer; the browser forwards decoded observations to the authenticated Moonbird room.

### Terminal fallback

Install the companion dependencies on the computer that can reach the Meshtastic node:

```sh
python3 -m venv .agent-venv
.agent-venv/bin/pip install -r requirements-agent.txt
```

The Radio Control panel's **Terminal companion fallback** section provides a command containing that participant's room token:

```sh
.agent-venv/bin/python -m moonbird_agent \
  --server https://moonbird.example \
  --room ROOMCODE \
  --callsign K7ABC \
  --token PARTICIPANT_TOKEN \
  --radio-host 192.168.1.50 \
  --allow-transmit
```

Omit `--allow-transmit` for capture-only operation. Moonbird validates and recommends configuration; it does not alter radio settings.

Choose exactly one radio option:

- TCP: `--radio-host 192.168.1.50`
- Serial: `--serial-port /dev/ttyUSB0` (or the appropriate Windows COM port)
- Bluetooth: `--bluetooth-address DEVICE_NAME_OR_OS_ADDRESS`

The fallback command generator uses the selected transport. Its Bluetooth scan can fill the advertised device name into the command. Browser-scoped Bluetooth IDs are not valid Meshtastic Python identifiers; an OS Bluetooth address can also be entered manually.

### TCP checklist

1. Configure the Meshtastic node to join Wi-Fi and note its LAN hostname or IP address.
2. From the computer that will run the companion, verify the Python client can reach it: `meshtastic --host RADIO_IP --info`.
3. In Moonbird's Radio Control panel, use `http://127.0.0.1:8000` as the server when Docker and the companion run on the same computer. Never use `0.0.0.0` as a client destination.
4. Enter the radio hostname/IP, copy the generated command, and run it from this repository with the agent virtual environment active.
5. Leave the terminal running. The badge changes to **Agent connected** when both the radio TCP connection and outbound Moonbird WebSocket are active.

If the agent exits with a connection error, check that the radio and companion computer are on the same LAN, use the numeric radio IP instead of `.local`, and rerun `meshtastic --host RADIO_IP --info`. For a remotely hosted Moonbird server, replace the localhost server value with its public HTTPS URL; no inbound radio port forwarding is needed.

Moonbird connects with Meshtastic's node-database download disabled. This avoids a known Python-client failure where one malformed cached remote `NodeInfo` makes the initial `FromRadio` stream fail protobuf parsing. Live NodeInfo and other received traffic are still captured by the agent.

### Display troubleshooting

The 3D view requires `three.module.js`, `three.core.js`, and `OrbitControls.js`. These are generated by `npm run build` and included by the Docker build. Rebuild with `docker compose up -d --build` after updating Moonbird.

## Detection limits

A detection is deliberately labeled a **candidate lunar return**. Moonbird always notifies when an RX packet matches a packet ID previously transmitted by the room. Measured delay, predicted lunar path delay, station geometry, and routing metadata affect the reported confidence but do not suppress the notification. A match does not by itself exclude a delayed terrestrial duplicate, clock error, receiver artifact, or another transmitter. Operators should synchronize clocks, use a dedicated channel, use hop limit zero, preserve raw observations, and independently review Doppler and RF evidence.

The astronomy model is a compact planning approximation and is not observatory-grade ephemeris software. The absolute link budget is intentionally displayed separately from relative propagation quality. The simple two-way lunar link estimate can have an extremely large negative margin; Moonbird does not present favorable geometry as proof that a station can close the RF link.

The Milky Way geometry uses the IAU J2000 Galactic coordinate transform, so its plane and center retain their real sky orientation relative to the Moon. The rendered star density is illustrative. Galactic radio degradation is an analytic approximation to the [Haslam 408 MHz all-sky survey](https://lambda.gsfc.nasa.gov/product/foreground/fg_2014_haslam_408_info.html), with enhanced plane, Galactic-center, and Cygnus regions. Brightness temperature is scaled to the station frequency with a -2.55 synchrotron spectral index and combined with an assumed 80 K receiver system temperature. It is intended for planning trends, not calibrated noise-temperature prediction.

The dashboard's vacuum path delay is the geometric Earth-Moon-Earth distance divided by light speed, normally about 2.4-2.7 seconds. It does not include LoRa packet airtime, the node transmit queue, amplifier switching, or receiver decode processing. A measured application-level return can therefore arrive later than the displayed geometric delay.

Operators are responsible for licensing, station identification, frequency coordination, emission rules, amplifier/filter safety, and local regulations.

## Transmit message format

Moonbird sends readable, FT8-style Meshtastic `TEXT_MESSAGE_APP` payloads with a room sequence suffix:

```text
CQ K7ABC CN85 #1
K7ABC W7XYZ -12 #2
W7XYZ K7ABC -09 #3
K7ABC W7XYZ R -12 #4
W7XYZ K7ABC 73 #5
CUSTOM MESSAGE #6
```

Sequences start at 1 and increase atomically across every transmitter in the room. The operator selects CQ, reply/report, report acknowledgment, Roger confirmation, sign-off, or custom; destination, signal report, and additional text remain editable. The source callsign and four-character grid come from the room station. Hop limit comes from the Meshtastic node configuration and is not overridden per message. ACK and response requests default to off.

## Test

```sh
python3 -m unittest discover -s tests -v
```

## Configuration

- `MOONBIRD_DB`: SQLite path, default `data/moonbird.sqlite3`
- `MOONBIRD_ROOM_HOURS`: active room duration, default `24`
- `MOONBIRD_RETENTION_DAYS`: stored traffic/detection retention, default `30`

## License

GPL-3.0-only. See [`LICENSE`](LICENSE).

Meshtastic® is a registered trademark of Meshtastic LLC. Meshtastic software components are released under various licenses, see GitHub for details. No warranty is provided - use at your own risk.
