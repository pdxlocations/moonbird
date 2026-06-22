from datetime import datetime, timezone
import unittest

from moonbird.astronomy import RadioProfile, Station, equatorial_to_galactic, galactic_sky_noise, great_circle_distance_km, sample_forecast, shared_forecast


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
        self.assertTrue(-90 <= sample["galactic_latitude_deg"] <= 90)
        self.assertGreaterEqual(sample["sky_noise_degradation_db"], 0)
        self.assertAlmostEqual(sample["eme_degradation_db"], sample["distance_degradation_db"] + sample["sky_noise_degradation_db"], places=2)
        self.assertTrue(0 <= sample["sun_azimuth_deg"] < 360)
        self.assertTrue(-90 <= sample["sun_elevation_deg"] <= 90)
        self.assertLess(sample["margin_db"], 0)

    def test_galactic_center_transform_and_noise_peak(self):
        longitude, latitude = equatorial_to_galactic(266.4051, -28.936175)
        wrapped_longitude = min(longitude, 360 - longitude)
        self.assertLess(wrapped_longitude, 0.01)
        self.assertLess(abs(latitude), 0.01)
        center = galactic_sky_noise(0, 0, 145.05)
        pole = galactic_sky_noise(0, 90, 145.05)
        microwave = galactic_sky_noise(0, 0, 2400)
        self.assertGreater(center["sky_temperature_k"], pole["sky_temperature_k"] * 10)
        self.assertGreater(center["sky_noise_degradation_db"], pole["sky_noise_degradation_db"])
        self.assertGreater(center["sky_noise_degradation_db"], microwave["sky_noise_degradation_db"])

    def test_shared_forecast_marks_simultaneous_visibility(self):
        remote = Station(35.0, 139.0)
        forecast = shared_forecast(self.station, remote, self.profile, "month", self.when)

        self.assertEqual(len(forecast["samples"]), 361)
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
