from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import signal
import sys
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def packet_observed_at(packet: dict[str, Any]) -> str:
    value = packet.get("rxTime", packet.get("rx_time"))
    try:
        timestamp = float(value)
        if math.isfinite(timestamp) and timestamp > 0:
            return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds")
    except (OSError, OverflowError, TypeError, ValueError):
        pass
    return now_iso()


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
    def __init__(self, target: str, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop, transport: str = "tcp"):
        self.target = target
        self.transport = transport
        self.queue = queue
        self.loop = loop
        self.interface = None

    def connect(self) -> None:
        try:
            from pubsub import pub
        except ImportError as exc:
            raise RuntimeError("Install agent dependencies with: pip install -r requirements-agent.txt") from exc
        # A malformed cached remote NodeInfo can make the Python client reject
        # the entire initial FromRadio database stream. Moonbird only needs the
        # local config plus live packets, so skip the historical node dump.
        if self.transport == "tcp":
            from meshtastic.tcp_interface import TCPInterface
            self.interface = TCPInterface(hostname=self.target, timeout=15, noNodes=True)
        elif self.transport == "serial":
            from meshtastic.serial_interface import SerialInterface
            self.interface = SerialInterface(devPath=self.target, timeout=15, noNodes=True)
        elif self.transport == "bluetooth":
            from meshtastic.ble_interface import BLEInterface
            self.interface = BLEInterface(address=self.target, timeout=30, noNodes=True)
        else:
            raise ValueError(f"unsupported radio transport: {self.transport}")
        pub.subscribe(self.on_receive, "meshtastic.receive")

    def close(self) -> None:
        if self.interface:
            self.interface.close()
            self.interface = None

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
                "observed_at": packet_observed_at(packet),
            },
        }
        self.loop.call_soon_threadsafe(self.queue.put_nowait, event)

    def status(self) -> dict[str, Any]:
        local_node = getattr(self.interface, "localNode", None)
        local_config = getattr(local_node, "localConfig", None)
        lora = protobuf_dict(getattr(local_config, "lora", None))
        metadata = protobuf_dict(getattr(self.interface, "metadata", None))
        node = getattr(self.interface, "myInfo", None)
        get_long_name = getattr(self.interface, "getLongName", None)
        try:
            long_name = get_long_name() if callable(get_long_name) else None
        except (AttributeError, KeyError, TypeError):
            long_name = None
        return {
            "connected": self.interface is not None,
            "transport": self.transport,
            "radio_target": self.target,
            "node": json_safe(node),
            "board_model": metadata.get("hw_model"),
            "long_name": long_name,
            "metadata": metadata,
            "lora_config": lora,
        }

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
    targets = {
        "tcp": args.radio_host,
        "serial": args.serial_port,
        "bluetooth": args.bluetooth_address,
    }
    transport, target = next((kind, value) for kind, value in targets.items() if value is not None)
    radio = RadioBridge(target, queue, loop, transport)
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
                    if command.get("type") == "disconnect_radio":
                        radio.close()
                        await queue.put({"type": "status", "status": radio.status()})
                        continue
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
    result = argparse.ArgumentParser(description="Connect a local Meshtastic node to a Moonbird room")
    result.add_argument("--server", required=True, help="Moonbird URL, for example https://moonbird.example")
    result.add_argument("--room", required=True, help="Room code")
    result.add_argument("--callsign", required=True)
    result.add_argument("--token", required=True, help="Participant agent token returned when joining")
    transport = result.add_mutually_exclusive_group(required=True)
    transport.add_argument("--radio-host", help="Meshtastic TCP hostname or IP")
    transport.add_argument("--serial-port", help="Meshtastic serial device path or port")
    transport.add_argument("--bluetooth-address", help="Meshtastic Bluetooth advertised name or OS address")
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
