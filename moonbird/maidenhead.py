from __future__ import annotations


def coordinates_from_maidenhead(locator: str) -> tuple[float, float]:
    grid = locator.strip().upper()
    if len(grid) < 2 or len(grid) > 10 or len(grid) % 2:
        raise ValueError("grid square must contain 2, 4, 6, 8, or 10 characters")

    longitude = -180.0
    latitude = -90.0
    lon_size = 20.0
    lat_size = 10.0

    for pair_index in range(len(grid) // 2):
        lon_char, lat_char = grid[pair_index * 2 : pair_index * 2 + 2]
        if pair_index % 2 == 0:
            limit = 18 if pair_index == 0 else 24
            lon_value = ord(lon_char) - ord("A")
            lat_value = ord(lat_char) - ord("A")
            if not 0 <= lon_value < limit or not 0 <= lat_value < limit:
                expected = "A-R" if pair_index == 0 else "A-X"
                raise ValueError(f"grid square pair {pair_index + 1} must use letters {expected}")
            if pair_index > 0:
                lon_size /= 24
                lat_size /= 24
        else:
            if not lon_char.isdigit() or not lat_char.isdigit():
                raise ValueError(f"grid square pair {pair_index + 1} must use digits 0-9")
            lon_value, lat_value = int(lon_char), int(lat_char)
            lon_size /= 10
            lat_size /= 10
        longitude += lon_value * lon_size
        latitude += lat_value * lat_size

    return round(latitude + lat_size / 2, 6), round(longitude + lon_size / 2, 6)


def maidenhead_from_coordinates(latitude: float, longitude: float, precision: int = 6) -> str:
    if precision < 2 or precision > 10 or precision % 2:
        raise ValueError("precision must be 2, 4, 6, 8, or 10")
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("coordinates are outside Maidenhead bounds")

    lon = min(longitude + 180.0, 360.0 - 1e-12)
    lat = min(latitude + 90.0, 180.0 - 1e-12)
    lon_size, lat_size = 20.0, 10.0
    result = []
    for pair_index in range(precision // 2):
        if pair_index > 0:
            divisor = 10 if pair_index % 2 else 24
            lon_size /= divisor
            lat_size /= divisor
        lon_value = int(lon / lon_size)
        lat_value = int(lat / lat_size)
        lon -= lon_value * lon_size
        lat -= lat_value * lat_size
        if pair_index % 2 == 0:
            result.extend((chr(ord("A") + lon_value), chr(ord("A") + lat_value)))
        else:
            result.extend((str(lon_value), str(lat_value)))
    return "".join(result)
