from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .maidenhead import coordinates_from_maidenhead

CALLSIGN_PATTERN = re.compile(r"^[A-Z0-9]{3,10}(?:-[A-Z0-9]{1,3})?$")


def normalize_callsign(value: str) -> str:
    callsign = value.strip().upper()
    if not CALLSIGN_PATTERN.fullmatch(callsign):
        raise ValueError("a valid amateur-radio callsign is required")
    return callsign


class StationInput(BaseModel):
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    grid_square: str | None = None
    elevation_m: float = Field(default=0, ge=-500, le=10_000)

    @model_validator(mode="after")
    def resolve_location(self):
        if self.grid_square and self.grid_square.strip():
            self.grid_square = self.grid_square.strip().upper()
            self.latitude, self.longitude = coordinates_from_maidenhead(self.grid_square)
        elif self.latitude is None or self.longitude is None:
            raise ValueError("enter a grid square or both latitude and longitude")
        return self


class RoomCreate(StationInput):
    title: str = Field(default="Moonbounce experiment", min_length=1, max_length=80)
    callsign: str
    equipment: dict[str, Any] = Field(default_factory=dict)

    _callsign = field_validator("callsign")(normalize_callsign)


class ParticipantJoin(StationInput):
    callsign: str
    equipment: dict[str, Any] = Field(default_factory=dict)

    _callsign = field_validator("callsign")(normalize_callsign)


class RoleUpdate(BaseModel):
    callsign: str
    role: Literal["transmitter", "receiver", "both", "observer"]
    admin_token: str

    _callsign = field_validator("callsign")(normalize_callsign)


class RadioDisconnect(BaseModel):
    agent_token: str = Field(min_length=1)


class ChatInput(BaseModel):
    text: str = Field(min_length=1, max_length=300)

    @field_validator("text")
    @classmethod
    def clean_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("chat message cannot be empty")
        return text


class TrafficInput(BaseModel):
    direction: Literal["tx", "rx", "event"]
    kind: str = Field(default="unknown", max_length=60)
    packet_id: str | None = Field(default=None, max_length=128)
    payload: dict[str, Any] = Field(default_factory=dict)
    raw_base64: str | None = None
    observed_at: str | None = None


class TransmitRequest(BaseModel):
    message_type: Literal["cq", "report", "report_ack", "roger", "signoff", "custom"] = "cq"
    text: str = Field(default="", max_length=160)
    destination_callsign: str = "ALL"
    report: int | None = Field(default=None, ge=-99, le=99)
    destination: str = Field(default="^all", min_length=1, max_length=32)
    channel: int = Field(default=0, ge=0, le=7)
    want_ack: bool = False
    want_response: bool = False

    @field_validator("destination_callsign")
    @classmethod
    def validate_destination_callsign(cls, value: str) -> str:
        destination = value.strip().upper() or "ALL"
        if destination != "ALL" and not CALLSIGN_PATTERN.fullmatch(destination):
            raise ValueError("destination callsign must be ALL or a valid amateur-radio callsign")
        return destination

    @model_validator(mode="after")
    def validate_message_fields(self):
        if self.message_type in {"report", "report_ack", "roger"} and self.report is None:
            raise ValueError("signal report is required for report and Roger messages")
        if self.message_type in {"report", "report_ack", "roger", "signoff"} and self.destination_callsign == "ALL":
            raise ValueError("a destination callsign is required for this message type")
        if self.message_type == "custom" and not self.text.strip():
            raise ValueError("custom message text is required")
        return self
