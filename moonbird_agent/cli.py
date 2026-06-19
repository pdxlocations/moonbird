from __future__ import annotations

import argparse
import asyncio
import base64
import json
import signal
import sys
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def json_safe(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def classify_packet(packet: dict[str, Any]) -> tuple[str, str | None]:
    decoded = packet.get("decoded") or {}
    port = str(decoded.get("portnum") or "unknown").lower()
    text = decoded.get("text") or ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    if isinstance(text, str) and text.startswith("MB1|"):
        parts = text.split("|", 3)
        return "moonbird_probe", parts[1] if len(parts) > 1 else None
    if isinstance(text, str):
        sequence = re.search(r"(?:^|\s)#(\d+)\s*$", text)
        if sequence:
            return "moonbird_probe", sequence.group(1)
    kinds = {
        "text_message_app": "text",
        "nodeinfo_app": "nodeinfo",
        "telemetry_app": "telemetry",
        "routing_app": "ack_or_routing",
        "position_app": "position",
        "neighborinfo_app": "neighborinfo",
    }
    return kinds.get(port, port), str(packet.get("id")) if packet.get("id") is not None else None


def protobuf_dict(message: Any) -> dict[str, Any]:
    if message is None:
        return {}
    try:
        from google.protobuf.json_format import MessageToDict
        return MessageToDict(message, preserving_proto_field_name=True)
    except Exception:
        return {"value": str(message)}


class RadioBridge:
    def __init__(self, host: str, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop):
        self.host = host
        self.queue = queue
        self.loop = loop
        self.interface = None

    def connect(self) -> None:
        try:
            from meshtastic.tcp_interface import TCPInterface
            from pubsub import pub
        except ImportError as exc:
            raise RuntimeError("Install agent dependencies with: pip install -r requirements-agent.txt") from exc
        # A malformed cached remote NodeInfo can make the Python client reject
        # the entire initial FromRadio database stream. Moonbird only needs the
        # local config plus live packets, so skip the historical node dump.
        self.interface = TCPInterface(hostname=self.host, timeout=15, noNodes=True)
        pub.subscribe(self.on_receive, "meshtastic.receive")

    def close(self) -> None:
        if self.interface:
            self.interface.close()

    def on_receive(self, packet, interface=None) -> None:
        safe_packet = json_safe(packet)
        kind, packet_id = classify_packet(packet)
        event = {
            "type": "traffic",
            "traffic": {
                "direction": "rx",
                "kind": kind,
                "packet_id": packet_id,
                "payload": safe_packet,
                "observed_at": now_iso(),
            },
        }
        self.loop.call_soon_threadsafe(self.queue.put_nowait, event)

    def status(self) -> dict[str, Any]:
        recommendations = [
            "Use a dedicated experiment channel.",
            "Configure hop limit in Meshtastic settings; Moonbird does not override it per message.",
            "Synchronize the agent computer clock with NTP.",
            "Confirm 145.050 MHz operation, station identification, power, and emission comply with local amateur rules.",
            "Verify amplifier duty cycle, filtering, antenna aim, and receive recovery before transmitting.",
        ]
        local_node = getattr(self.interface, "localNode", None)
        local_config = getattr(local_node, "localConfig", None)
        lora = protobuf_dict(getattr(local_config, "lora", None))
        channels = json_safe(getattr(local_node, "channels", []))
        configured_hops = lora.get("hop_limit")
        checks = [
            {"name": "TCP radio", "status": "pass", "detail": self.host},
            {
                "name": "Default hop limit",
                "status": "pass" if configured_hops is not None else "review",
                "detail": f"{configured_hops if configured_hops is not None else 'unknown'}; using node configuration",
            },
            {
                "name": "Dedicated channel",
                "status": "review",
                "detail": f"{len(channels) if isinstance(channels, list) else 'unknown'} channel records; confirm the selected channel is experiment-only",
            },
            {"name": "145.050 MHz RF chain", "status": "review", "detail": "Frequency, BPF, amplifier, and antenna cannot be verified through the Meshtastic TCP API"},
        ]
        node = getattr(self.interface, "myInfo", None)
        return {"connected": self.interface is not None, "tcp_host": self.host, "node": json_safe(node), "lora_config": lora, "checks": checks, "recommendations": recommendations}

    def transmit(self, command: dict[str, Any], callsign: str) -> dict[str, Any]:
        if not self.interface:
            raise RuntimeError("radio is not connected")
        sequence_value = command.get("sequence", command.get("packet_id"))
        if sequence_value is None:
            raise ValueError("transmit command is missing its room sequence")
        sequence = int(sequence_value)
        wire_text = str(command.get("wire_text") or "").strip()
        if not wire_text:
            raise ValueError("transmit command is missing its formatted message")
        kwargs = {
            "destinationId": command.get("destination", "^all"),
            "channelIndex": int(command.get("channel", 0)),
            "wantAck": bool(command.get("want_ack", False)),
            "wantResponse": bool(command.get("want_response", False)),
            "portNum": 1,
        }
        result = self.interface.sendText(wire_text, **kwargs)
        return {
            "type": "traffic",
            "traffic": {
                "direction": "tx",
                "kind": "moonbird_probe",
                "packet_id": str(sequence),
                "payload": {"text": wire_text, "command": command, "meshtastic_result": json_safe(result)},
                "observed_at": now_iso(),
            },
        }


async def run(args: argparse.Namespace) -> None:
    try:
        import websockets
    except ImportError as exc:
        raise RuntimeError("Install agent dependencies with: pip install -r requirements-agent.txt") from exc

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    radio = RadioBridge(args.radio_host, queue, loop)
    radio.connect()
    scheme = "wss" if args.server.startswith("https://") else "ws"
    server = args.server.split("://", 1)[-1].rstrip("/")
    uri = f"{scheme}://{server}/ws/agents/{quote(args.room.upper())}/{quote(args.callsign.upper())}?token={quote(args.token)}"

    async def outbound(socket) -> None:
        while True:
            await socket.send(json.dumps(await queue.get()))

    try:
        async with websockets.connect(uri, ping_interval=20, ping_timeout=20) as socket:
            await socket.send(json.dumps({"type": "status", "status": radio.status()}))
            sender = asyncio.create_task(outbound(socket))
            try:
                async for raw in socket:
                    command = json.loads(raw)
                    if command.get("type") != "transmit":
                        continue
                    if not args.allow_transmit:
                        await queue.put({"type": "status", "status": {**radio.status(), "transmit_rejected": "restart agent with --allow-transmit"}})
                        continue
                    await queue.put(radio.transmit(command, args.callsign.upper()))
            finally:
                sender.cancel()
    finally:
        radio.close()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Connect a local Meshtastic TCP node to a Moonbird room")
    result.add_argument("--server", required=True, help="Moonbird URL, for example https://moonbird.example")
    result.add_argument("--room", required=True, help="Room code")
    result.add_argument("--callsign", required=True)
    result.add_argument("--token", required=True, help="Participant agent token returned when joining")
    result.add_argument("--radio-host", required=True, help="Local Meshtastic TCP hostname or IP")
    result.add_argument("--allow-transmit", action="store_true", help="Allow this server room to request radio transmissions")
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"Moonbird agent error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
