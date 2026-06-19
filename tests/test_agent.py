import unittest
import asyncio
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from moonbird_agent.cli import RadioBridge, classify_packet, json_safe


class AgentTests(unittest.TestCase):
    def test_probe_packet_is_classified_by_wire_id(self):
        kind, packet_id = classify_packet({"id": 9, "decoded": {"portnum": "TEXT_MESSAGE_APP", "text": "MB1|MB-123|K7ABC|test"}})
        self.assertEqual(kind, "moonbird_probe")
        self.assertEqual(packet_id, "MB-123")

    def test_ft8_style_probe_is_classified_by_sequence_suffix(self):
        kind, sequence = classify_packet({"id": 10, "decoded": {"portnum": "TEXT_MESSAGE_APP", "text": "CQ K7ABC CN85 #17"}})
        self.assertEqual(kind, "moonbird_probe")
        self.assertEqual(sequence, "17")

    def test_background_nodeinfo_is_retained_as_its_own_kind(self):
        kind, packet_id = classify_packet({"id": 12, "decoded": {"portnum": "NODEINFO_APP", "payload": b"abc"}})
        self.assertEqual(kind, "nodeinfo")
        self.assertEqual(packet_id, "12")
        self.assertEqual(json_safe(b"abc"), {"base64": "YWJj"})

    def test_radio_connection_skips_historical_node_database(self):
        options = {}
        tcp_module = ModuleType("meshtastic.tcp_interface")
        tcp_module.TCPInterface = lambda **kwargs: options.update(kwargs) or SimpleNamespace()
        pub_module = ModuleType("pubsub")
        pub_module.pub = SimpleNamespace(subscribe=lambda *args: None)
        loop = asyncio.new_event_loop()
        with patch.dict(sys.modules, {"meshtastic.tcp_interface": tcp_module, "pubsub": pub_module}):
            bridge = RadioBridge("radio.local", asyncio.Queue(), loop)
            bridge.connect()
        loop.close()

        self.assertTrue(options["noNodes"])
        self.assertEqual(options["timeout"], 15)

    def test_transmit_builds_exact_envelope_and_meshtastic_fields(self):
        sent = {}
        interface = SimpleNamespace(sendText=lambda text, **kwargs: sent.update(text=text, **kwargs) or {"id": 9})
        loop = asyncio.new_event_loop()
        bridge = RadioBridge("radio.local", asyncio.Queue(), loop)
        bridge.interface = interface
        event = bridge.transmit({
            "sequence": 17,
            "wire_text": "JA1XYZ K7ABC -12 #17",
            "destination": "!20783f27",
            "channel": 2,
            "want_ack": False,
            "want_response": True,
        }, "K7ABC")

        self.assertEqual(sent["text"], "JA1XYZ K7ABC -12 #17")
        self.assertEqual(sent["destinationId"], "!20783f27")
        self.assertEqual(sent["channelIndex"], 2)
        self.assertFalse(sent["wantAck"])
        self.assertTrue(sent["wantResponse"])
        self.assertNotIn("hopLimit", sent)
        self.assertNotIn("replyId", sent)
        self.assertEqual(sent["portNum"], 1)
        self.assertEqual(event["traffic"]["packet_id"], "17")
        loop.close()


if __name__ == "__main__":
    unittest.main()
