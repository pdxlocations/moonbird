import unittest

from moonbird.maidenhead import coordinates_from_maidenhead, maidenhead_from_coordinates


class MaidenheadTests(unittest.TestCase):
    def test_portland_grid_resolves_to_cell_center(self):
        latitude, longitude = coordinates_from_maidenhead("CN85QM")

        self.assertAlmostEqual(latitude, 45.520833, places=5)
        self.assertAlmostEqual(longitude, -122.625, places=5)

    def test_coordinates_encode_to_six_character_grid(self):
        self.assertEqual(maidenhead_from_coordinates(45.5152, -122.6784), "CN85PM")

    def test_round_trip_coordinate_remains_inside_grid_cell(self):
        grid = maidenhead_from_coordinates(35.6762, 139.6503, precision=8)
        latitude, longitude = coordinates_from_maidenhead(grid)

        self.assertLess(abs(latitude - 35.6762), 0.005)
        self.assertLess(abs(longitude - 139.6503), 0.005)

    def test_invalid_grid_is_rejected(self):
        for grid in ("", "CN8", "SN85", "CN8Z"):
            with self.subTest(grid=grid), self.assertRaises(ValueError):
                coordinates_from_maidenhead(grid)


if __name__ == "__main__":
    unittest.main()
