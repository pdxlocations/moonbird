import unittest

from moonbird_agent.protocol import build_probe_message


class ProtocolTests(unittest.TestCase):
    def test_ft8_style_contact_sequence(self):
        common = {"source_grid": "CN85"}
        self.assertEqual(build_probe_message(sequence=1, message_type="cq", source="K7ABC", **common), "CQ K7ABC CN85 #1")
        self.assertEqual(build_probe_message(sequence=2, message_type="report", source="W7XYZ", destination="K7ABC", report=-12, **common), "K7ABC W7XYZ -12 #2")
        self.assertEqual(build_probe_message(sequence=3, message_type="report_ack", source="K7ABC", destination="W7XYZ", report=-9, **common), "W7XYZ K7ABC -09 #3")
        self.assertEqual(build_probe_message(sequence=4, message_type="roger", source="W7XYZ", destination="K7ABC", report=-12, **common), "K7ABC W7XYZ R -12 #4")
        self.assertEqual(build_probe_message(sequence=5, message_type="signoff", source="K7ABC", destination="W7XYZ", **common), "W7XYZ K7ABC 73 #5")

    def test_custom_and_additional_text(self):
        self.assertEqual(build_probe_message(sequence=6, message_type="custom", source="K7ABC", source_grid="CN85", text="TRY AGAIN"), "TRY AGAIN #6")
        self.assertEqual(build_probe_message(sequence=7, message_type="cq", source="K7ABC", source_grid="CN85", text="MOON TEST"), "CQ K7ABC CN85 MOON TEST #7")


if __name__ == "__main__":
    unittest.main()
