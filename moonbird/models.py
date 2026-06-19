from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator_callsign TEXT NOT NULL,
    admin_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    callsign TEXT NOT NULL,
    role TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_m REAL NOT NULL DEFAULT 0,
    equipment_json TEXT NOT NULL DEFAULT '{}',
    agent_token TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    UNIQUE(room_code, callsign),
    FOREIGN KEY(room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    callsign TEXT NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    packet_id TEXT,
    payload_json TEXT NOT NULL,
    raw_base64 TEXT,
    received_at TEXT NOT NULL,
    FOREIGN KEY(room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS traffic_room_time ON traffic(room_code, received_at);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    callsign TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    FOREIGN KEY(room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_room_time ON chat_messages(room_code, sent_at);
CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    tx_callsign TEXT NOT NULL,
    rx_callsign TEXT NOT NULL,
    confidence REAL NOT NULL,
    delay_ms REAL,
    predicted_delay_ms REAL,
    doppler_hz REAL,
    evidence_json TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    FOREIGN KEY(room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS probe_sequences (
    room_code TEXT PRIMARY KEY,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(room_code) REFERENCES rooms(code) ON DELETE CASCADE
);
"""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Database:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        with self.connect() as conn:
            cursor = conn.execute(sql, params)
            return int(cursor.lastrowid or cursor.rowcount)

    def purge(self, retention_days: int) -> None:
        cutoff = (utc_now() - timedelta(days=retention_days)).isoformat()
        with self.connect() as conn:
            conn.execute("DELETE FROM traffic WHERE received_at < ?", (cutoff,))
            conn.execute("DELETE FROM detections WHERE detected_at < ?", (cutoff,))
            conn.execute("DELETE FROM rooms WHERE expires_at < ? AND created_at < ?", (cutoff, cutoff))

    def next_probe_sequence(self, room_code: str) -> int:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT OR IGNORE INTO probe_sequences (room_code, next_sequence) VALUES (?, 1)", (room_code,))
            sequence = int(conn.execute("SELECT next_sequence FROM probe_sequences WHERE room_code = ?", (room_code,)).fetchone()[0])
            conn.execute("UPDATE probe_sequences SET next_sequence = ? WHERE room_code = ?", (sequence + 1, room_code))
            return sequence
