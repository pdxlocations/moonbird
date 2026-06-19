from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import WebSocket


class RoomHub:
    def __init__(self) -> None:
        self.browsers: dict[str, set[WebSocket]] = defaultdict(set)
        self.agents: dict[tuple[str, str], WebSocket] = {}
        self.agent_statuses: dict[tuple[str, str], dict[str, Any]] = {}

    async def add_browser(self, room: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.browsers[room].add(websocket)

    def remove_browser(self, room: str, websocket: WebSocket) -> None:
        self.browsers[room].discard(websocket)

    async def add_agent(self, room: str, callsign: str, websocket: WebSocket) -> None:
        await websocket.accept()
        old = self.agents.get((room, callsign))
        if old:
            await old.close(code=4001, reason="A newer agent connected")
        self.agents[(room, callsign)] = websocket
        self.agent_statuses.pop((room, callsign), None)

    def remove_agent(self, room: str, callsign: str, websocket: WebSocket) -> None:
        if self.agents.get((room, callsign)) is websocket:
            self.agents.pop((room, callsign), None)
            self.agent_statuses.pop((room, callsign), None)

    def set_agent_status(self, room: str, callsign: str, status: dict[str, Any]) -> None:
        self.agent_statuses[(room, callsign)] = status

    def agent_status(self, room: str, callsign: str) -> dict[str, Any] | None:
        return self.agent_statuses.get((room, callsign))

    async def broadcast(self, room: str, message: dict[str, Any]) -> None:
        stale = []
        for websocket in self.browsers[room]:
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.browsers[room].discard(websocket)

    async def command_agent(self, room: str, callsign: str, message: dict[str, Any]) -> bool:
        agent = self.agents.get((room, callsign))
        if not agent:
            return False
        await agent.send_json(message)
        return True

    def agent_connected(self, room: str, callsign: str) -> bool:
        key = (room, callsign)
        status = self.agent_statuses.get(key)
        return key in self.agents and (status is None or status.get("connected", False))
