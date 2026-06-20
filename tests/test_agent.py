import unittest
import asyncio
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from moonbird_agent.cli import RadioBridge, classify_packet, json_safe, packet_observed_at, parser


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

    def test_packet_timestamp_uses_radio_receive_time(self):
        self.assertEqual(packet_observed_at({"rxTime": 1_750_000_000}), "2025-06-15T15:06:40.000+00:00")
        self.assertNotEqual(packet_observed_at({"rxTime": 0}), "1970-01-01T00:00:00.000+00:00")

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

    def test_serial_and_bluetooth_interfaces_receive_selected_targets(self):
        cases = [
            ("serial", "meshtastic.serial_interface", "SerialInterface", "/dev/ttyUSB0", "devPath", 15),
            ("bluetooth", "meshtastic.ble_interface", "BLEInterface", "AA:BB:CC:DD:EE:FF", "address", 30),
        ]
        for transport, module_name, class_name, target, target_key, timeout in cases:
            with self.subTest(transport=transport):
                options = {}
                interface_module = ModuleType(module_name)
                setattr(interface_module, class_name, lambda **kwargs: options.update(kwargs) or SimpleNamespace())
                pub_module = ModuleType("pubsub")
                pub_module.pub = SimpleNamespace(subscribe=lambda *args: None)
                loop = asyncio.new_event_loop()
                with patch.dict(sys.modules, {module_name: interface_module, "pubsub": pub_module}):
                    RadioBridge(target, asyncio.Queue(), loop, transport).connect()
                loop.close()
                self.assertEqual(options[target_key], target)
                self.assertEqual(options["timeout"], timeout)
                self.assertTrue(options["noNodes"])

    def test_cli_requires_exactly_one_radio_transport(self):
        common = ["--server", "http://localhost", "--room", "ROOM1234", "--callsign", "K7ABC", "--token", "secret"]
        self.assertEqual(parser().parse_args([*common, "--serial-port", "/dev/ttyUSB0"]).serial_port, "/dev/ttyUSB0")
        with self.assertRaises(SystemExit):
            parser().parse_args(common)
        with self.assertRaises(SystemExit):
            parser().parse_args([*common, "--radio-host", "radio.local", "--bluetooth-address", "device-id"])

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

    def test_status_reports_radio_board_model_from_metadata(self):
        loop = asyncio.new_event_loop()
        bridge = RadioBridge("radio.local", asyncio.Queue(), loop)
        bridge.interface = SimpleNamespace(
            localNode=SimpleNamespace(localConfig=SimpleNamespace(lora=None), channels=[]),
            metadata=SimpleNamespace(),
            myInfo=None,
            getLongName=lambda: "Portland Moonbird",
        )
        with patch("moonbird_agent.cli.protobuf_dict", side_effect=lambda value: {"hw_model": "TBEAM"} if value is bridge.interface.metadata else {}):
            status = bridge.status()

        self.assertEqual(status["board_model"], "TBEAM")
        self.assertEqual(status["long_name"], "Portland Moonbird")
        loop.close()


if __name__ == "__main__":
    unittest.main()
