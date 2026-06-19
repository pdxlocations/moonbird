from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

LIGHT_KM_S = 299_792.458
EARTH_RADIUS_KM = 6378.14
MOON_REFLECTION_LOSS_DB = 120.0


@dataclass(frozen=True)
class Station:
    latitude: float
    longitude: float
    elevation_m: float = 0.0


@dataclass(frozen=True)
class RadioProfile:
    frequency_mhz: float = 145.05
    tx_power_dbm: float = 46.99
    tx_gain_dbi: float = 11.6
    rx_gain_dbi: float = 11.6
    rx_sensitivity_dbm: float = -137.0
    system_loss_db: float = 3.0


def julian_day(when: datetime) -> float:
    when = when.astimezone(timezone.utc)
    year, month = when.year, when.month
    day = when.day + (when.hour + (when.minute + when.second / 60) / 60) / 24
    if month <= 2:
        year -= 1
        month += 12
    a = year // 100
    b = 2 - a + a // 4
    return math.floor(365.25 * (year + 4716)) + math.floor(30.6001 * (month + 1)) + day + b - 1524.5


def wrap(value: float) -> float:
    return value % 360.0


def great_circle_distance_km(left: Station, right: Station) -> float:
    """Distance between stations along the Earth's surface."""
    left_lat, right_lat = math.radians(left.latitude), math.radians(right.latitude)
    delta_lat = right_lat - left_lat
    delta_lon = math.radians(right.longitude - left.longitude)
    haversine = math.sin(delta_lat / 2) ** 2 + math.cos(left_lat) * math.cos(right_lat) * math.sin(delta_lon / 2) ** 2
    return round(2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, haversine))), 1)


def moon_topocentric(station: Station, when: datetime) -> dict[str, Any]:
    """Compact lunar ephemeris suitable for experiment planning, not precision pointing."""
    jd = julian_day(when)
    d = jd - 2451543.5
    node = wrap(125.1228 - 0.0529538083 * d)
    inclination = 5.1454
    periapsis = wrap(318.0634 + 0.1643573223 * d)
    semi_major = 60.2666
    eccentricity = 0.0549
    mean_anomaly = wrap(115.3654 + 13.0649929509 * d)
    m = math.radians(mean_anomaly)
    eccentric_anomaly = m + eccentricity * math.sin(m) * (1 + eccentricity * math.cos(m))
    xv = semi_major * (math.cos(eccentric_anomaly) - eccentricity)
    yv = semi_major * math.sqrt(1 - eccentricity**2) * math.sin(eccentric_anomaly)
    true_anomaly = math.atan2(yv, xv)
    radius_earth = math.hypot(xv, yv)
    lon = true_anomaly + math.radians(periapsis)
    n, inc = math.radians(node), math.radians(inclination)
    x = radius_earth * (math.cos(n) * math.cos(lon) - math.sin(n) * math.sin(lon) * math.cos(inc))
    y = radius_earth * (math.sin(n) * math.cos(lon) + math.cos(n) * math.sin(lon) * math.cos(inc))
    z = radius_earth * math.sin(lon) * math.sin(inc)
    ecliptic_lon = math.atan2(y, x)
    ecliptic_lat = math.atan2(z, math.hypot(x, y))
    obliquity = math.radians(23.4393 - 3.563e-7 * d)
    xe = math.cos(ecliptic_lon) * math.cos(ecliptic_lat)
    ye = math.sin(ecliptic_lon) * math.cos(ecliptic_lat) * math.cos(obliquity) - math.sin(ecliptic_lat) * math.sin(obliquity)
    ze = math.sin(ecliptic_lon) * math.cos(ecliptic_lat) * math.sin(obliquity) + math.sin(ecliptic_lat) * math.cos(obliquity)
    ra = math.atan2(ye, xe)
    declination = math.atan2(ze, math.hypot(xe, ye))
    gmst = wrap(280.46061837 + 360.98564736629 * (jd - 2451545.0))
    hour_angle = math.radians(wrap(gmst + station.longitude - math.degrees(ra)))
    if hour_angle > math.pi:
        hour_angle -= 2 * math.pi
    latitude = math.radians(station.latitude)
    altitude = math.asin(math.sin(latitude) * math.sin(declination) + math.cos(latitude) * math.cos(declination) * math.cos(hour_angle))
    azimuth = math.atan2(-math.sin(hour_angle), math.tan(declination) * math.cos(latitude) - math.sin(latitude) * math.cos(hour_angle))
    geocentric_range_km = radius_earth * EARTH_RADIUS_KM
    station_radius_km = EARTH_RADIUS_KM + station.elevation_m / 1000
    range_km = math.sqrt(
        geocentric_range_km**2 + station_radius_km**2
        - 2 * geocentric_range_km * station_radius_km * math.sin(altitude)
    )
    sun_mean_lon = wrap(280.460 + 0.9856474 * (jd - 2451545.0))
    sun_anomaly = math.radians(wrap(357.528 + 0.9856003 * (jd - 2451545.0)))
    sun_lon = math.radians(wrap(sun_mean_lon + 1.915 * math.sin(sun_anomaly) + 0.020 * math.sin(2 * sun_anomaly)))
    sun_ra = math.atan2(math.cos(obliquity) * math.sin(sun_lon), math.cos(sun_lon))
    sun_dec = math.asin(math.sin(obliquity) * math.sin(sun_lon))
    sun_hour_angle = math.radians(wrap(gmst + station.longitude - math.degrees(sun_ra)))
    if sun_hour_angle > math.pi:
        sun_hour_angle -= 2 * math.pi
    sun_altitude = math.asin(math.sin(latitude) * math.sin(sun_dec) + math.cos(latitude) * math.cos(sun_dec) * math.cos(sun_hour_angle))
    sun_azimuth = math.atan2(-math.sin(sun_hour_angle), math.tan(sun_dec) * math.cos(latitude) - math.sin(latitude) * math.cos(sun_hour_angle))
    separation = math.acos(max(-1.0, min(1.0, math.sin(declination) * math.sin(sun_dec) + math.cos(declination) * math.cos(sun_dec) * math.cos(ra - sun_ra))))
    return {
        "azimuth_deg": round(wrap(math.degrees(azimuth)), 2),
        "elevation_deg": round(math.degrees(altitude), 2),
        "declination_deg": round(math.degrees(declination), 2),
        "solar_separation_deg": round(math.degrees(separation), 2),
        "sun_azimuth_deg": round(wrap(math.degrees(sun_azimuth)), 2),
        "sun_elevation_deg": round(math.degrees(sun_altitude), 2),
        "illumination_percent": round((1 - math.cos(separation)) * 50, 1),
        "distance_km": round(range_km, 1),
        "round_trip_ms": round(2 * range_km / LIGHT_KM_S * 1000, 2),
        "visible": altitude > 0,
    }


def link_metrics(station: Station, profile: RadioProfile, when: datetime) -> dict[str, Any]:
    moon = moon_topocentric(station, when)
    distance = moon["distance_km"]
    wavelength_m = 299.792458 / profile.frequency_mhz
    one_way_fspl = 92.45 + 20 * math.log10(profile.frequency_mhz / 1000) + 20 * math.log10(distance)
    total_loss = 2 * one_way_fspl + MOON_REFLECTION_LOSS_DB + profile.system_loss_db
    predicted_rx = profile.tx_power_dbm + profile.tx_gain_dbi + profile.rx_gain_dbi - total_loss
    margin = predicted_rx - profile.rx_sensitivity_dbm
    distance_penalty = max(0.0, 40 * math.log10(distance / 356_500))
    elevation_penalty = 35.0 if moon["elevation_deg"] <= 0 else max(0.0, 12.0 - moon["elevation_deg"] * 0.4)
    solar_penalty = max(0.0, 18.0 - moon["solar_separation_deg"]) * 0.8
    relative_quality = max(0.0, min(100.0, 100 - distance_penalty * 5 - elevation_penalty * 2 - solar_penalty * 2))
    return {
        **moon,
        "frequency_mhz": profile.frequency_mhz,
        "wavelength_m": round(wavelength_m, 4),
        "two_way_fspl_db": round(2 * one_way_fspl, 2),
        "total_loss_db": round(total_loss, 2),
        "predicted_rx_dbm": round(predicted_rx, 2),
        "margin_db": round(margin, 2),
        "quality": round(relative_quality, 1),
        "distance_degradation_db": round(distance_penalty, 2),
    }


def sample_forecast(station: Station, profile: RadioProfile, span: str, start: datetime | None = None) -> dict[str, Any]:
    start = (start or datetime.now(timezone.utc)).astimezone(timezone.utc)
    schedules = {
        "hour": (timedelta(minutes=2), 31),
        "day": (timedelta(minutes=15), 97),
        "month": (timedelta(hours=6), 121),
        "year": (timedelta(days=3), 122),
    }
    if span not in schedules:
        raise ValueError("span must be hour, day, month, or year")
    step, count = schedules[span]
    samples = []
    previous_distance = moon_topocentric(station, start - step)["distance_km"]
    for index in range(count):
        at = start + step * index
        metrics = link_metrics(station, profile, at)
        radial_km_s = 0.0
        if previous_distance is not None:
            radial_km_s = (metrics["distance_km"] - previous_distance) / step.total_seconds()
        metrics["doppler_hz"] = round(-2 * radial_km_s * 1000 / metrics["wavelength_m"], 2)
        metrics["at"] = at.isoformat(timespec="seconds")
        samples.append(metrics)
        previous_distance = metrics["distance_km"]
    return {"span": span, "station": station.__dict__, "profile": profile.__dict__, "samples": samples}


def shared_forecast(tx: Station, rx: Station, profile: RadioProfile, span: str, start: datetime | None = None) -> dict[str, Any]:
    tx_data = sample_forecast(tx, profile, span, start)
    rx_data = sample_forecast(rx, profile, span, start)
    samples = []
    for left, right in zip(tx_data["samples"], rx_data["samples"]):
        samples.append({
            "at": left["at"],
            "tx": left,
            "rx": right,
            "moon_path_distance_km": round(left["distance_km"] + right["distance_km"], 1),
            "shared_visible": bool(left["visible"] and right["visible"]),
        })
    return {
        "span": span,
        "tx_station": tx.__dict__,
        "rx_station": rx.__dict__,
        "earth_path_distance_km": great_circle_distance_km(tx, rx),
        "samples": samples,
    }
