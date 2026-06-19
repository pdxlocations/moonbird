from __future__ import annotations


def format_signal_report(value: int | None) -> str:
    if value is None:
        raise ValueError("a signal report is required for this message type")
    return f"{value:+03d}"


def build_probe_message(
    *,
    sequence: int,
    message_type: str,
    source: str,
    source_grid: str,
    destination: str = "ALL",
    report: int | None = None,
    text: str = "",
) -> str:
    source = source.strip().upper()
    destination = destination.strip().upper() or "ALL"
    extra = text.strip()

    if message_type == "cq":
        body = f"CQ {source} {source_grid.upper()}"
    elif message_type in {"report", "report_ack"}:
        body = f"{destination} {source} {format_signal_report(report)}"
    elif message_type == "roger":
        body = f"{destination} {source} R {format_signal_report(report)}"
    elif message_type == "signoff":
        body = f"{destination} {source} 73"
    elif message_type == "custom":
        if not extra:
            raise ValueError("custom message text is required")
        body = extra
        extra = ""
    else:
        raise ValueError(f"unsupported message type: {message_type}")

    if extra:
        body = f"{body} {extra}"
    return f"{body} #{int(sequence)}"
