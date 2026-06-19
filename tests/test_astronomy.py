from datetime import datetime, timezone
import unittest

from moonbird.astronomy import RadioProfile, Station, great_circle_distance_km, sample_forecast, shared_forecast


class AstronomyTests(unittest.TestCase):
    def setUp(self):
        self.station = Station(45.5152, -122.6784)
        self.profile = RadioProfile()
        self.when = datetime(2026, 6, 18, 12, tzinfo=timezone.utc)

    def test_hour_forecast_contains_pointing_and_propagation_metrics(self):
        forecast = sample_forecast(self.station, self.profile, "hour", self.when)
        sample = forecast["samples"][0]

        self.assertEqual(len(forecast["samples"]), 31)
        self.assertTrue(0 <= sample["azimuth_deg"] < 360)
        self.assertTrue(-90 <= sample["elevation_deg"] <= 90)
        self.assertGreater(sample["round_trip_ms"], 2000)
        self.assertIn("doppler_hz", sample)
        self.assertIn("solar_separation_deg", sample)
        self.assertTrue(0 <= sample["sun_azimuth_deg"] < 360)
        self.assertTrue(-90 <= sample["sun_elevation_deg"] <= 90)
        self.assertLess(sample["margin_db"], 0)

    def test_shared_forecast_marks_simultaneous_visibility(self):
        remote = Station(35.0, 139.0)
        forecast = shared_forecast(self.station, remote, self.profile, "month", self.when)

        self.assertEqual(len(forecast["samples"]), 121)
        self.assertTrue(all("shared_visible" in sample for sample in forecast["samples"]))
        first = forecast["samples"][0]
        self.assertAlmostEqual(first["moon_path_distance_km"], first["tx"]["distance_km"] + first["rx"]["distance_km"], places=1)
        self.assertEqual(forecast["earth_path_distance_km"], great_circle_distance_km(self.station, remote))
        self.assertTrue(7_000 < forecast["earth_path_distance_km"] < 9_000)

    def test_invalid_span_is_rejected(self):
        with self.assertRaises(ValueError):
            sample_forecast(self.station, self.profile, "decade", self.when)


if __name__ == "__main__":
    unittest.main()
