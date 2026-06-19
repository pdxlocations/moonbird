from __future__ import annotations

import csv
import io
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .astronomy import LIGHT_KM_S, RadioProfile, Station, sample_forecast, shared_forecast
from .config import Settings, load_settings
from .maidenhead import maidenhead_from_coordinates
from .models import Database, utc_now
from .realtime import RoomHub
from .schemas import ChatInput, ParticipantJoin, RadioDisconnect, RoleUpdate, RoomCreate, TrafficInput, TransmitRequest
from moonbird_agent.protocol import build_probe_message


def room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def public_room(db: Database, code: str) -> dict[str, Any]:
    room = db.one("SELECT code, title, creator_callsign, created_at, expires_at FROM rooms WHERE code = ?", (code,))
    if not room:
        raise HTTPException(404, "room not found")
    room["participants"] = db.query(
        "SELECT callsign, role, latitude, longitude, elevation_m, equipment_json, joined_at FROM participants WHERE room_code = ? ORDER BY joined_at",
        (code,),
    )
    for participant in room["participants"]:
        participant["equipment"] = json.loads(participant.pop("equipment_json"))
        participant["grid_square"] = maidenhead_from_coordinates(participant["latitude"], participant["longitude"])
    return room


def parse_time(value: str | None) -> datetime:
    if not value:
        return utc_now()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return utc_now()


def station_for(participant: dict[str, Any]) -> Station:
    return Station(participant["latitude"], participant["longitude"], participant["elevation_m"])


def maybe_detection(db: Database, code: str, rx_callsign: str, traffic: TrafficInput, received_at: datetime) -> dict[str, Any] | None:
    if traffic.direction != "rx" or traffic.kind != "moonbird_probe" or not traffic.packet_id:
        return None
    sent = db.one(
        "SELECT callsign, payload_json, received_at FROM traffic WHERE room_code = ? AND packet_id = ? AND direction = 'tx' ORDER BY id DESC LIMIT 1",
        (code, traffic.packet_id),
    )
    if not sent:
        return None
    tx = db.one("SELECT * FROM participants WHERE room_code = ? AND callsign = ?", (code, sent["callsign"]))
    rx = db.one("SELECT * FROM participants WHERE room_code = ? AND callsign = ?", (code, rx_callsign))
    if not tx or not rx:
        return None
    sent_at = parse_time(json.loads(sent["payload_json"]).get("observed_at") or sent["received_at"])
    delay_ms = (received_at - sent_at).total_seconds() * 1000
    tx_moon = sample_forecast(station_for(tx), RadioProfile(), "hour", sent_at)["samples"][0]
    rx_moon = sample_forecast(station_for(rx), RadioProfile(), "hour", sent_at)["samples"][0]
    if not tx_moon["visible"] or not rx_moon["visible"]:
        return None
    predicted_ms = (tx_moon["distance_km"] + rx_moon["distance_km"]) / LIGHT_KM_S * 1000
    timing_error = abs(delay_ms - predicted_ms)
    timing_score = max(0.0, 1.0 - timing_error / 450.0)
    route = traffic.payload.get("decoded", traffic.payload)
    hop_limit = route.get("hopLimit", route.get("hop_limit"))
    route_score = 1.0 if hop_limit in (0, None) else 0.25
    id_score = 1.0
    confidence = round(0.65 * timing_score + 0.2 * route_score + 0.15 * id_score, 3)
    if timing_error > 900:
        return None
    evidence = {
        "classification": "candidate_lunar_path",
        "timing_error_ms": round(timing_error, 2),
        "matching_packet_id": True,
        "simultaneous_moon_visibility": True,
        "route_hop_limit": hop_limit,
        "tx_moon_elevation_deg": tx_moon["elevation_deg"],
        "rx_moon_elevation_deg": rx_moon["elevation_deg"],
        "note": "Timing correlation is evidence, not proof; terrestrial relays and clock error must be excluded.",
    }
    detection_id = db.execute(
        "INSERT INTO detections (room_code, packet_id, tx_callsign, rx_callsign, confidence, delay_ms, predicted_delay_ms, doppler_hz, evidence_json, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (code, traffic.packet_id, sent["callsign"], rx_callsign, confidence, delay_ms, predicted_ms, rx_moon["doppler_hz"], json.dumps(evidence), received_at.isoformat()),
    )
    return {
        "id": detection_id,
        "packet_id": traffic.packet_id,
        "tx_callsign": sent["callsign"],
        "rx_callsign": rx_callsign,
        "confidence": confidence,
        "delay_ms": round(delay_ms, 2),
        "predicted_delay_ms": round(predicted_ms, 2),
        "doppler_hz": rx_moon["doppler_hz"],
        "evidence": evidence,
        "detected_at": received_at.isoformat(),
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    db = Database(settings.database_path)
    db.purge(settings.retention_days)
    hub = RoomHub()
    app = FastAPI(title="Moonbird", version="0.1.0")
    app.state.db = db
    app.state.hub = hub
    static = Path(__file__).resolve().parent.parent / "static"

    @app.get("/")
    async def index():
        return FileResponse(static / "index.html")

    @app.get("/api/health")
    async def health():
        return {"ok": True, "service": "moonbird"}

    @app.post("/api/rooms", status_code=201)
    async def create_room(payload: RoomCreate):
        code = room_code()
        admin_token = secrets.token_urlsafe(24)
        agent_token = secrets.token_urlsafe(24)
        now = utc_now()
        expires = now + timedelta(hours=settings.room_hours)
        with db.connect() as conn:
            conn.execute("INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?)", (code, payload.title, payload.callsign, admin_token, now.isoformat(), expires.isoformat()))
            conn.execute(
                "INSERT INTO participants (room_code, callsign, role, latitude, longitude, elevation_m, equipment_json, agent_token, joined_at) VALUES (?, ?, 'both', ?, ?, ?, ?, ?, ?)",
                (code, payload.callsign, payload.latitude, payload.longitude, payload.elevation_m, json.dumps(payload.equipment), agent_token, now.isoformat()),
            )
        return {**public_room(db, code), "admin_token": admin_token, "agent_token": agent_token}

    @app.get("/api/rooms/{code}")
    async def get_room(code: str):
        return public_room(db, code.upper())

    @app.post("/api/rooms/{code}/participants", status_code=201)
    async def join_room(code: str, payload: ParticipantJoin):
        code = code.upper()
        public_room(db, code)
        token = secrets.token_urlsafe(24)
        now = utc_now().isoformat()
        try:
            db.execute(
                "INSERT INTO participants (room_code, callsign, role, latitude, longitude, elevation_m, equipment_json, agent_token, joined_at) VALUES (?, ?, 'receiver', ?, ?, ?, ?, ?, ?)",
                (code, payload.callsign, payload.latitude, payload.longitude, payload.elevation_m, json.dumps(payload.equipment), token, now),
            )
        except Exception as exc:
            if "UNIQUE" in str(exc):
                raise HTTPException(409, "callsign already joined") from exc
            raise
        await hub.broadcast(code, {"type": "room", "room": public_room(db, code)})
        return {"room": public_room(db, code), "agent_token": token}

    @app.patch("/api/rooms/{code}/roles")
    async def update_role(code: str, payload: RoleUpdate):
        code = code.upper()
        room = db.one("SELECT admin_token FROM rooms WHERE code = ?", (code,))
        if not room or not secrets.compare_digest(room["admin_token"], payload.admin_token):
            raise HTTPException(403, "room administrator token required")
        db.execute("UPDATE participants SET role = ? WHERE room_code = ? AND callsign = ?", (payload.role, code, payload.callsign))
        result = public_room(db, code)
        await hub.broadcast(code, {"type": "room", "room": result})
        return result

    @app.get("/api/rooms/{code}/traffic")
    async def traffic(code: str, limit: int = Query(default=200, ge=1, le=5000)):
        rows = db.query("SELECT * FROM traffic WHERE room_code = ? ORDER BY id DESC LIMIT ?", (code.upper(), limit))
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
        return rows

    @app.get("/api/rooms/{code}/chat")
    async def chat_history(code: str, limit: int = Query(default=50, ge=1, le=200)):
        code = code.upper()
        if not db.one("SELECT code FROM rooms WHERE code = ?", (code,)):
            raise HTTPException(404, "room not found")
        return db.query(
            "SELECT id, callsign, text, sent_at FROM (SELECT id, callsign, text, sent_at FROM chat_messages WHERE room_code = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
            (code, limit),
        )

    @app.get("/api/rooms/{code}/detections")
    async def detections(code: str):
        rows = db.query("SELECT * FROM detections WHERE room_code = ? ORDER BY id DESC", (code.upper(),))
        for row in rows:
            row["evidence"] = json.loads(row.pop("evidence_json"))
        return rows

    @app.post("/api/rooms/{code}/transmit/{callsign}")
    async def transmit(code: str, callsign: str, payload: TransmitRequest):
        code, callsign = code.upper(), callsign.upper()
        participant = db.one("SELECT role, latitude, longitude FROM participants WHERE room_code = ? AND callsign = ?", (code, callsign))
        if not participant or participant["role"] not in {"transmitter", "both"}:
            raise HTTPException(403, "participant is not assigned a transmit role")
        if not hub.agent_connected(code, callsign):
            raise HTTPException(409, "local companion agent is not connected")
        sequence = db.next_probe_sequence(code)
        source_grid = maidenhead_from_coordinates(participant["latitude"], participant["longitude"], precision=4)
        wire_text = build_probe_message(
            sequence=sequence,
            message_type=payload.message_type,
            source=callsign,
            source_grid=source_grid,
            destination=payload.destination_callsign,
            report=payload.report,
            text=payload.text,
        )
        command = {"type": "transmit", "sequence": sequence, "packet_id": str(sequence), "source_grid": source_grid, "wire_text": wire_text, **payload.model_dump()}
        if not await hub.command_agent(code, callsign, command):
            raise HTTPException(409, "local companion agent is not connected")
        return {"queued": True, "sequence": sequence, "wire_text": wire_text}

    @app.post("/api/rooms/{code}/radio/{callsign}/disconnect")
    async def disconnect_radio(code: str, callsign: str, payload: RadioDisconnect):
        code, callsign = code.upper(), callsign.upper()
        participant = db.one("SELECT agent_token FROM participants WHERE room_code = ? AND callsign = ?", (code, callsign))
        if not participant or not secrets.compare_digest(participant["agent_token"], payload.agent_token):
            raise HTTPException(403, "participant agent token required")
        disconnected = await hub.command_agent(code, callsign, {"type": "disconnect_radio"})
        if disconnected:
            status = {**(hub.agent_status(code, callsign) or {}), "connected": False}
            hub.set_agent_status(code, callsign, status)
            await hub.broadcast(code, {"type": "agent_status", "callsign": callsign, "status": status})
        return {"disconnected": disconnected}

    @app.get("/api/planning")
    async def planning(lat: float, lon: float, elevation_m: float = 0, span: str = "hour", remote_lat: float | None = None, remote_lon: float | None = None, remote_elevation_m: float = 0):
        try:
            station = Station(lat, lon, elevation_m)
            profile = RadioProfile()
            if remote_lat is not None and remote_lon is not None:
                return shared_forecast(station, Station(remote_lat, remote_lon, remote_elevation_m), profile, span)
            return sample_forecast(station, profile, span)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/rooms/{code}/export.json")
    async def export_json(code: str):
        code = code.upper()
        return JSONResponse({"room": public_room(db, code), "traffic": await traffic(code, 5000), "detections": await detections(code)})

    @app.get("/api/rooms/{code}/traffic.csv")
    async def export_csv(code: str):
        rows = db.query("SELECT id, callsign, direction, kind, packet_id, payload_json, raw_base64, received_at FROM traffic WHERE room_code = ? ORDER BY id", (code.upper(),))
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=["id", "callsign", "direction", "kind", "packet_id", "payload_json", "raw_base64", "received_at"])
        writer.writeheader()
        writer.writerows(rows)
        return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="moonbird-{code}.csv"'})

    async def ingest(code: str, callsign: str, item: TrafficInput) -> None:
        observed = parse_time(item.observed_at)
        payload = {**item.payload, "observed_at": observed.isoformat()}
        record_id = db.execute(
            "INSERT INTO traffic (room_code, callsign, direction, kind, packet_id, payload_json, raw_base64, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (code, callsign, item.direction, item.kind, item.packet_id, json.dumps(payload), item.raw_base64, observed.isoformat()),
        )
        event = {"type": "traffic", "traffic": {"id": record_id, "callsign": callsign, **item.model_dump(), "payload": payload, "received_at": observed.isoformat()}}
        await hub.broadcast(code, event)
        detection = maybe_detection(db, code, callsign, item, observed)
        if detection:
            await hub.broadcast(code, {"type": "detection", "detection": detection})

    @app.websocket("/ws/rooms/{code}")
    async def room_socket(websocket: WebSocket, code: str, callsign: str | None = Query(default=None), token: str | None = Query(default=None)):
        code = code.upper()
        if not db.one("SELECT code FROM rooms WHERE code = ?", (code,)):
            await websocket.close(code=4404)
            return
        await hub.add_browser(code, websocket)
        local_callsign = callsign.upper() if callsign else None
        authenticated_callsign = None
        if local_callsign and token:
            participant = db.one("SELECT agent_token FROM participants WHERE room_code = ? AND callsign = ?", (code, local_callsign))
            if participant and secrets.compare_digest(participant["agent_token"], token):
                authenticated_callsign = local_callsign
        try:
            await websocket.send_json({"type": "room", "room": public_room(db, code)})
            if local_callsign:
                connected = hub.agent_connected(code, local_callsign)
                if connected:
                    await websocket.send_json({"type": "agent", "callsign": local_callsign, "connected": True})
                    status = hub.agent_status(code, local_callsign)
                    if status is not None:
                        await websocket.send_json({"type": "agent_status", "callsign": local_callsign, "status": status})
            while True:
                raw = await websocket.receive_text()
                if raw == "ping":
                    continue
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get("type") != "chat" or not authenticated_callsign:
                    if message.get("type") == "radio_status" and authenticated_callsign:
                        status = message.get("status", {})
                        if not isinstance(status, dict):
                            continue
                        if status.get("connected"):
                            await hub.bind_agent(code, authenticated_callsign, websocket)
                            hub.set_agent_status(code, authenticated_callsign, status)
                            board_model = status.get("board_model")
                            if isinstance(board_model, str) and board_model.strip():
                                row = db.one("SELECT equipment_json FROM participants WHERE room_code = ? AND callsign = ?", (code, authenticated_callsign))
                                equipment = json.loads(row["equipment_json"]) if row else {}
                                equipment["radio"] = board_model.strip()[:80]
                                db.execute(
                                    "UPDATE participants SET equipment_json = ? WHERE room_code = ? AND callsign = ?",
                                    (json.dumps(equipment), code, authenticated_callsign),
                                )
                                await hub.broadcast(code, {"type": "room", "room": public_room(db, code)})
                            await hub.broadcast(code, {"type": "agent", "callsign": authenticated_callsign, "connected": True})
                        else:
                            hub.remove_agent(code, authenticated_callsign, websocket)
                        await hub.broadcast(code, {"type": "agent_status", "callsign": authenticated_callsign, "status": status})
                        continue
                    if message.get("type") == "traffic" and authenticated_callsign and hub.agents.get((code, authenticated_callsign)) is websocket:
                        await ingest(code, authenticated_callsign, TrafficInput.model_validate(message.get("traffic", {})))
                    continue
                try:
                    chat = ChatInput.model_validate(message)
                except ValueError:
                    await websocket.send_json({"type": "chat_error", "detail": "Enter a message up to 300 characters."})
                    continue
                sent_at = utc_now().isoformat()
                message_id = db.execute(
                    "INSERT INTO chat_messages (room_code, callsign, text, sent_at) VALUES (?, ?, ?, ?)",
                    (code, authenticated_callsign, chat.text, sent_at),
                )
                await hub.broadcast(code, {"type": "chat", "message": {"id": message_id, "callsign": authenticated_callsign, "text": chat.text, "sent_at": sent_at}})
        except WebSocketDisconnect:
            pass
        finally:
            hub.remove_browser(code, websocket)
            if authenticated_callsign and hub.remove_agent(code, authenticated_callsign, websocket):
                await hub.broadcast(code, {"type": "agent", "callsign": authenticated_callsign, "connected": False})

    @app.websocket("/ws/agents/{code}/{callsign}")
    async def agent_socket(websocket: WebSocket, code: str, callsign: str, token: str = Query(...)):
        code, callsign = code.upper(), callsign.upper()
        participant = db.one("SELECT agent_token FROM participants WHERE room_code = ? AND callsign = ?", (code, callsign))
        if not participant or not secrets.compare_digest(participant["agent_token"], token):
            await websocket.close(code=4403)
            return
        await hub.add_agent(code, callsign, websocket)
        await hub.broadcast(code, {"type": "agent", "callsign": callsign, "connected": True})
        try:
            while True:
                message = await websocket.receive_json()
                if message.get("type") == "traffic":
                    await ingest(code, callsign, TrafficInput.model_validate(message.get("traffic", {})))
                elif message.get("type") == "status":
                    status = message.get("status", {})
                    if not isinstance(status, dict):
                        continue
                    hub.set_agent_status(code, callsign, status)
                    board_model = status.get("board_model") if isinstance(status, dict) else None
                    if isinstance(board_model, str) and board_model.strip():
                        row = db.one("SELECT equipment_json FROM participants WHERE room_code = ? AND callsign = ?", (code, callsign))
                        equipment = json.loads(row["equipment_json"]) if row else {}
                        equipment["radio"] = board_model.strip()[:80]
                        db.execute(
                            "UPDATE participants SET equipment_json = ? WHERE room_code = ? AND callsign = ?",
                            (json.dumps(equipment), code, callsign),
                        )
                        await hub.broadcast(code, {"type": "room", "room": public_room(db, code)})
                    await hub.broadcast(code, {"type": "agent_status", "callsign": callsign, "status": status})
        except WebSocketDisconnect:
            pass
        finally:
            if hub.remove_agent(code, callsign, websocket):
                await hub.broadcast(code, {"type": "agent", "callsign": callsign, "connected": False})

    app.mount("/static", StaticFiles(directory=static), name="static")
    return app


app = create_app()
