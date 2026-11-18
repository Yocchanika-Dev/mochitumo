import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from b003_lock import B003Lock  # noqa: E402


class B003LockTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "b003.sqlite"
        self.target = {"device_id": "mock-b003", "relay_id": "mock-usb"}
        self.drive_calls = []
        self.frames = []
        self.diagnostics = []

    def controller(self, confirms):
        lock = B003Lock(self.database, **self.target,
                        drive=self.drive_calls.append, confirms_position=confirms,
                        diagnose=self.diagnostics.append)
        self.addCleanup(lock.close)
        return lock

    def command(self, action="unlock", command_id="cmd-1", **overrides):
        message = {"v": 1, "message_type": "command", "command_id": command_id,
                   "action": action, "request_id": "req-fixture", "bike_id": "B003", **self.target}
        message.update(overrides)
        return message

    def test_json_lines_tap_retry_and_round_trip(self):
        messages = [
            {"message_type": "mock_tap", "card_uid": "0123456789abcdef"},
            {"message_type": "mock_retry_tap"},
            self.command(),
            self.command("lock", "cmd-2"),
        ]
        invocation = [sys.executable, str(ROOT / "tools/mock_b003_lock.py"),
                      "--db", str(self.database), "--device-id", self.target["device_id"],
                      "--relay-id", self.target["relay_id"]]

        def run(batch):
            result = subprocess.run(invocation, input="".join(
                json.dumps(item) + "\n" for item in batch
            ), text=True, capture_output=True, check=True)
            return [json.loads(line) for line in result.stdout.splitlines()], result.stderr

        frames, debug = run(messages)
        tap = frames[0]
        self.assertEqual(tap, {"v": 1, "message_type": "card_tap", "card_uid": "0123456789ABCDEF",
                               "action": "unlock", **self.target,
                               "client_request_id": tap["client_request_id"]})
        self.assertEqual(uuid.UUID(tap["client_request_id"]).version, 4)
        self.assertEqual(frames[1], tap)
        for index, command in enumerate(messages[2:]):
            reply = {"v": 1, "request_id": command["request_id"],
                     "command_id": command["command_id"], "bike_id": command["bike_id"],
                     **self.target}
            offset = 2 + 2 * index
            self.assertEqual(frames[offset:offset + 2], [
                {"message_type": "ack", **reply},
                {"message_type": "result", **reply, "result": command["action"] + "_success"},
            ])
        self.assertEqual(debug.splitlines(), ["mock drive unlock", "mock drive lock"])
        replay, debug = run([messages[2], messages[3]])
        self.assertEqual(replay, frames[2:])
        self.assertEqual(debug, "")

    def test_rejections_and_other_targets_do_not_drive(self):
        lock = self.controller(lambda action: True)
        for reason in ("unapproved", "wrong_card", "wrong_lock", "accepted"):
            lock.receive({"message_type": "card_tap_result", "reason": reason}, self.frames.append)
        lock.receive({"message_type": "approved"}, self.frames.append)
        lock.receive(self.command(device_id="another-device"), self.frames.append)
        lock.receive(self.command(relay_id="another-relay"), self.frames.append)
        lock.receive(self.command(bike_id="B004"), self.frames.append)
        for invalid in ({"v": 2}, {"v": True}, {"request_id": ""}, {"bike_id": None}):
            lock.receive(self.command(**invalid), self.frames.append)
        old_command = self.command()
        old_command["type"] = old_command.pop("message_type")
        lock.receive(old_command, self.frames.append)
        self.assertEqual((self.drive_calls, self.frames), ([], []))

    def test_success_requires_physical_confirmation_and_failure_is_replayed(self):
        lock = self.controller(lambda action: False)
        for action in ("unlock", "lock"):
            command = self.command(action, action)
            lock.receive(command, self.frames.append)
            lock.receive(command, self.frames.append)
            self.assertEqual(self.frames[-2:], self.frames[-4:-2])
            result = json.loads(self.frames[-1])
            self.assertEqual(result["result"], action + "_failed")
            self.assertNotIn("reason", result)
        self.assertEqual(self.diagnostics, ["physical_position_unconfirmed"] * 2)
        self.assertEqual(self.drive_calls, ["unlock", "lock"])

    def test_interrupted_claim_never_drives_again(self):
        lock = self.controller(lambda action: True)
        db = sqlite3.connect(self.database)
        with db:
            db.execute("INSERT INTO commands (id, action) VALUES (?, ?)", ("cmd-1", "unlock"))
        db.close()
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO commands (id, action, request_id) VALUES (?, ?, ?)",
                       ("cmd-2", "lock", "req-fixture"))
        for action, command_id in (("unlock", "cmd-1"), ("lock", "cmd-2")):
            command = self.command(action, command_id)
            lock.receive(command, self.frames.append)
            result = json.loads(self.frames[-1])
            self.assertEqual(result["result"], action + "_failed")
            self.assertNotIn("reason", result)
            lock.receive(command, self.frames.append)
            self.assertEqual(self.frames[-2:], self.frames[-4:-2])
        self.assertEqual(self.diagnostics, ["position_unknown_after_interruption"] * 2)
        count = len(self.frames)
        lock.receive(self.command("lock"), self.frames.append)
        lock.receive(self.command(request_id="req-other"), self.frames.append)
        self.assertEqual(len(self.frames), count)
        self.assertEqual(self.drive_calls, [])
        self.assertEqual(self.diagnostics[-2:], ["command_id_conflict"] * 2)

    def test_legacy_database_migrates_without_redriving_old_command(self):
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE commands (id TEXT PRIMARY KEY, action TEXT, result TEXT)")
            db.execute("INSERT INTO commands VALUES (?, ?, ?)",
                       ("cmd-1", "unlock", '{"type":"command_result","result":"unlock_success"}'))
        lock = self.controller(lambda action: True)
        lock.receive(self.command(), self.frames.append)
        self.assertEqual(self.drive_calls, [])
        self.assertEqual(json.loads(self.frames[-1])["result"], "unlock_failed")
        self.assertEqual(self.diagnostics, ["legacy_request_id_unknown"])
