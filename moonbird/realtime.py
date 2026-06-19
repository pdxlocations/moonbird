from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import WebSocket


class RoomHub:
    def __init__(self) -> None:
        self.browsers: dict[str, set[WebSocket]] = defaultdict(set)
        self.agents: dict[tuple[str, str], WebSocket] = {}

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

    def remove_agent(self, room: str, callsign: str, websocket: WebSocket) -> None:
        if self.agents.get((room, callsign)) is websocket:
            self.agents.pop((room, callsign), None)

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
        return (room, callsign) in self.agents
