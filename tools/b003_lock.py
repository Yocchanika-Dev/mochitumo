"""B003 lock controller for an exclusive, trusted USB relay connection."""

import json
import re
import sqlite3
import uuid


class B003Lock:
    def __init__(self, database, device_id, relay_id, drive, confirms_position,
                 diagnose=lambda reason: None):
        if not device_id or not relay_id:
            raise ValueError("device_id and relay_id are required")
        self.target = {"device_id": device_id, "relay_id": relay_id}
        self.drive = drive
        self.confirms_position = confirms_position
        self.diagnose = diagnose
        self.db = sqlite3.connect(database)
        self.db.execute("PRAGMA synchronous=FULL")
        with self.db:
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS commands (
                    id TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT, request_id TEXT
                )
            """)
            columns = self.db.execute("PRAGMA table_info(commands)").fetchall()
            if not any(column[1] == "request_id" for column in columns):
                self.db.execute("ALTER TABLE commands ADD COLUMN request_id TEXT")

    def close(self):
        self.db.close()

    def card_tap(self, idm):
        """Create one frame per new physical tap. Retain the frame for retransmission."""
        if not isinstance(idm, str) or not re.fullmatch(r"[0-9a-fA-F]{16}", idm):
            raise ValueError("expected a 16-character hexadecimal IDm")
        return self.json_line("card_tap", {
            "card_uid": idm.upper(),
            "action": "unlock",
            "client_request_id": str(uuid.uuid4()),
            **self.target,
        })

    @staticmethod
    def json_line(message_type, fields):
        message = {"v": 1, "message_type": message_type, **fields}
        return json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n"

    def receive(self, message, send):
        """Only a separate, addressed v1 command can reach the actuator."""
        if (not isinstance(message, dict) or type(message.get("v")) is not int
                or message["v"] != 1 or message.get("message_type") != "command"):
            return
        if message.get("bike_id") != "B003":
            return
        if any(message.get(key) != value for key, value in self.target.items()):
            return
        command_id = message.get("command_id")
        request_id = message.get("request_id")
        action = message.get("action")
        for identifier in (command_id, request_id):
            if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 128:
                return
        if action not in ("unlock", "lock"):
            return

        reply = {key: message[key] for key in
                 ("request_id", "command_id", "bike_id", "device_id", "relay_id")}
        # Commit the claim before any possible actuation.
        with self.db:
            inserted = self.db.execute(
                "INSERT OR IGNORE INTO commands (id, action, request_id) VALUES (?, ?, ?)",
                (command_id, action, request_id),
            ).rowcount
            stored_action, stored_request, result = self.db.execute(
                "SELECT action, request_id, result FROM commands WHERE id = ?", (command_id,)
            ).fetchone()
        if stored_action != action or stored_request not in (None, request_id):
            self.diagnose("command_id_conflict")
            return

        send(self.json_line("ack", reply))
        if inserted or stored_request is None or result is None:
            if inserted:
                result = self._operate(action)
            else:
                reason = "position_unknown_after_interruption"
                if stored_request is None and result is not None:
                    reason = "legacy_request_id_unknown"
                self.diagnose(reason)
                result = action + "_failed"
            with self.db:
                self.db.execute("UPDATE commands SET request_id = ?, result = ? WHERE id = ?",
                                (request_id, result, command_id))
        send(self.json_line("result", {**reply, "result": result}))

    def _operate(self, action):
        try:
            self.drive(action)
            if self.confirms_position(action) is True:
                return action + "_success"
            reason = "physical_position_unconfirmed"
        except Exception:
            reason = "hardware_error"
        self.diagnose(reason)
        return action + "_failed"
