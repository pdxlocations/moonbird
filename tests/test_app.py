import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from moonbird.app import create_app
from moonbird.config import Settings


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Settings(str(Path(self.temp.name) / "test.sqlite3")))
        self.client = TestClient(self.app)

    def tearDown(self):
        self.temp.cleanup()

    def create_room(self):
        response = self.client.post("/api/rooms", json={
            "title": "June EME test",
            "callsign": "K7ABC",
            "latitude": 45.5152,
            "longitude": -122.6784,
            "equipment": {"amplifier_w": 50},
        })
        self.assertEqual(response.status_code, 201)
        return response.json()

    def test_room_join_role_and_export_flow(self):
        room = self.create_room()
        joined = self.client.post(f"/api/rooms/{room['code']}/participants", json={
            "callsign": "JA1XYZ",
            "latitude": 35.6762,
            "longitude": 139.6503,
        })
        self.assertEqual(joined.status_code, 201)
        updated = self.client.patch(f"/api/rooms/{room['code']}/roles", json={
            "callsign": "JA1XYZ",
            "role": "receiver",
            "admin_token": room["admin_token"],
        })
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(len(updated.json()["participants"]), 2)
        exported = self.client.get(f"/api/rooms/{room['code']}/export.json")
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.json()["room"]["code"], room["code"])

    def test_callsign_is_required_and_validated(self):
        response = self.client.post("/api/rooms", json={"callsign": "not a call!", "latitude": 0, "longitude": 0})
        self.assertEqual(response.status_code, 422)

    def test_room_can_be_created_and_joined_with_grid_squares(self):
        created = self.client.post("/api/rooms", json={
            "title": "Grid test", "callsign": "K7ABC", "grid_square": "CN85QM",
        })
        self.assertEqual(created.status_code, 201)
        room = created.json()
        self.assertEqual(room["participants"][0]["grid_square"], "CN85QM")

        joined = self.client.post(f"/api/rooms/{room['code']}/participants", json={
            "callsign": "JA1XYZ", "grid_square": "PM95UQ",
        })
        self.assertEqual(joined.status_code, 201)
        self.assertEqual(joined.json()["room"]["participants"][1]["grid_square"], "PM95UQ")

    def test_planning_supports_all_requested_spans_and_remote_station(self):
        for span, count in (("hour", 31), ("day", 97), ("month", 121), ("year", 122)):
            response = self.client.get(f"/api/planning?lat=45.5&lon=-122.6&remote_lat=35.6&remote_lon=139.6&span={span}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()["samples"]), count)
            self.assertIn("shared_visible", response.json()["samples"][0])

    def test_transmit_requires_connected_agent(self):
        room = self.create_room()
        response = self.client.post(f"/api/rooms/{room['code']}/transmit/K7ABC", json={"text": "test"})
        self.assertEqual(response.status_code, 409)

    def test_participants_can_chat_and_recover_history(self):
        room = self.create_room()
        joined = self.client.post(f"/api/rooms/{room['code']}/participants", json={
            "callsign": "JA1XYZ", "latitude": 35.6762, "longitude": 139.6503,
        }).json()
        code = room["code"]
        with self.client.websocket_connect(f"/ws/rooms/{code}?callsign=K7ABC&token={room['agent_token']}") as sender:
            self.assertEqual(sender.receive_json()["type"], "room")
            with self.client.websocket_connect(f"/ws/rooms/{code}?callsign=JA1XYZ&token={joined['agent_token']}") as receiver:
                self.assertEqual(receiver.receive_json()["type"], "room")
                sender.send_json({"type": "chat", "text": "Moon visible here"})
                sent = sender.receive_json()
                received = receiver.receive_json()
                self.assertEqual(sent["type"], "chat")
                self.assertEqual(received["message"]["callsign"], "K7ABC")
                self.assertEqual(received["message"]["text"], "Moon visible here")
        history = self.client.get(f"/api/rooms/{code}/chat").json()
        self.assertEqual(history[-1]["text"], "Moon visible here")

    def test_authenticated_browser_can_serve_as_radio_endpoint(self):
        room = self.create_room()
        code = room["code"]
        with self.client.websocket_connect(f"/ws/rooms/{code}?callsign=K7ABC&token={room['agent_token']}") as browser:
            self.assertEqual(browser.receive_json()["type"], "room")
            browser.send_json({"type": "radio_status", "status": {"connected": True, "transport": "serial", "long_name": "Portland Moonbird"}})
            self.assertEqual(browser.receive_json(), {"type": "agent", "callsign": "K7ABC", "connected": True})
            status = browser.receive_json()
            self.assertEqual(status["type"], "agent_status")
            self.assertEqual(status["status"]["long_name"], "Portland Moonbird")

            response = self.client.post(f"/api/rooms/{code}/transmit/K7ABC", json={"text": "browser"})
            self.assertEqual(response.status_code, 200)
            command = browser.receive_json()
            self.assertEqual(command["type"], "transmit")
            self.assertEqual(command["wire_text"], "CQ K7ABC CN85 browser #1")

            disconnected = self.client.post(
                f"/api/rooms/{code}/radio/K7ABC/disconnect",
                json={"agent_token": room["agent_token"]},
            )
            self.assertTrue(disconnected.json()["disconnected"])
            self.assertEqual(browser.receive_json(), {"type": "disconnect_radio"})
            self.assertFalse(browser.receive_json()["status"]["connected"])

    def test_agent_stream_transmit_and_candidate_detection(self):
        room = self.create_room()
        code = room["code"]
        with self.client.websocket_connect(f"/ws/rooms/{code}") as browser:
            self.assertEqual(browser.receive_json()["type"], "room")
            with self.client.websocket_connect(f"/ws/agents/{code}/K7ABC?token={room['agent_token']}") as agent:
                self.assertEqual(browser.receive_json()["type"], "agent")
                agent.send_json({"type": "status", "status": {"connected": True, "board_model": "TBEAM"}})
                room_update = browser.receive_json()
                self.assertEqual(room_update["type"], "room")
                self.assertEqual(room_update["room"]["participants"][0]["equipment"]["radio"], "TBEAM")
                self.assertEqual(browser.receive_json()["type"], "agent_status")
                with self.client.websocket_connect(f"/ws/rooms/{code}?callsign=K7ABC") as late_browser:
                    self.assertEqual(late_browser.receive_json()["type"], "room")
                    self.assertEqual(late_browser.receive_json(), {"type": "agent", "callsign": "K7ABC", "connected": True})
                    late_status = late_browser.receive_json()
                    self.assertEqual(late_status["type"], "agent_status")
                    self.assertEqual(late_status["status"]["board_model"], "TBEAM")
                response = self.client.post(f"/api/rooms/{code}/transmit/K7ABC", json={
                    "message_type": "report", "text": "test", "destination_callsign": "ja1xyz", "report": -12,
                    "destination": "!20783f27", "channel": 2, "want_ack": False, "want_response": True,
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["sequence"], 1)
                command = agent.receive_json()
                self.assertEqual(command["type"], "transmit")
                self.assertEqual(command["sequence"], 1)
                self.assertEqual(command["packet_id"], "1")
                self.assertEqual(command["destination_callsign"], "JA1XYZ")
                self.assertEqual(command["destination"], "!20783f27")
                self.assertEqual(command["channel"], 2)
                self.assertFalse(command["want_ack"])
                self.assertTrue(command["want_response"])
                self.assertNotIn("hop_limit", command)
                self.assertNotIn("reply_id", command)
                self.assertEqual(command["wire_text"], "JA1XYZ K7ABC -12 test #1")
                sent_at = datetime(2026, 6, 18, 0, tzinfo=timezone.utc)
                agent.send_json({"type": "traffic", "traffic": {
                    "direction": "tx", "kind": "moonbird_probe", "packet_id": command["packet_id"],
                    "payload": {"text": "probe"}, "observed_at": sent_at.isoformat(),
                }})
                self.assertEqual(browser.receive_json()["type"], "traffic")
                agent.send_json({"type": "traffic", "traffic": {
                    "direction": "rx", "kind": "moonbird_probe", "packet_id": command["packet_id"],
                    "payload": {"decoded": {"hopLimit": 0}},
                    "observed_at": (sent_at + timedelta(milliseconds=2500)).isoformat(),
                }})
                self.assertEqual(browser.receive_json()["type"], "traffic")
                detection = browser.receive_json()
                self.assertEqual(detection["type"], "detection")
                self.assertGreater(detection["detection"]["confidence"], 0.7)
                agent.send_json({"type": "traffic", "traffic": {
                    "direction": "rx", "kind": "moonbird_probe", "packet_id": command["packet_id"],
                    "payload": {"decoded": {"hopLimit": 0}},
                    "observed_at": (sent_at + timedelta(seconds=30)).isoformat(),
                }})
                self.assertEqual(browser.receive_json()["type"], "traffic")
                late_detection = browser.receive_json()
                self.assertEqual(late_detection["type"], "detection")
                self.assertEqual(late_detection["detection"]["evidence"]["classification"], "matching_packet_return")
                self.assertGreater(late_detection["detection"]["evidence"]["timing_error_ms"], 900)
                second = self.client.post(f"/api/rooms/{code}/transmit/K7ABC", json={"text": "second"})
                self.assertEqual(second.json()["sequence"], 2)
                second_command = agent.receive_json()
                self.assertEqual(second_command["sequence"], 2)
                self.assertFalse(second_command["want_ack"])
                self.assertFalse(second_command["want_response"])
                self.assertEqual(second_command["wire_text"], "CQ K7ABC CN85 second #2")
                denied = self.client.post(f"/api/rooms/{code}/radio/K7ABC/disconnect", json={"agent_token": "wrong"})
                self.assertEqual(denied.status_code, 403)
                disconnected = self.client.post(
                    f"/api/rooms/{code}/radio/K7ABC/disconnect",
                    json={"agent_token": room["agent_token"]},
                )
                self.assertEqual(disconnected.status_code, 200)
                self.assertTrue(disconnected.json()["disconnected"])
                self.assertEqual(agent.receive_json(), {"type": "disconnect_radio"})

    def test_transmit_rejects_invalid_destination_callsign(self):
        room = self.create_room()
        response = self.client.post(f"/api/rooms/{room['code']}/transmit/K7ABC", json={
            "text": "test", "destination_callsign": "not-a-call-sign",
        })
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
