from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_path: str = "data/moonbird.sqlite3"
    room_hours: int = 24
    retention_days: int = 30


def load_settings() -> Settings:
    return Settings(
        database_path=os.getenv("MOONBIRD_DB", "data/moonbird.sqlite3"),
        room_hours=int(os.getenv("MOONBIRD_ROOM_HOURS", "24")),
        retention_days=int(os.getenv("MOONBIRD_RETENTION_DAYS", "30")),
    )
