"""JSON Lines bench simulator. Uses synthetic cards and a simulated position."""

import argparse
import json
import sys

from b003_lock import B003Lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="persistent simulator database")
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--relay-id", required=True)
    args = parser.parse_args()
    position = "lock"

    def drive(action):
        nonlocal position
        position = action
        print("mock drive " + action, file=sys.stderr, flush=True)

    def send(frame):
        sys.stdout.write(frame)
        sys.stdout.flush()

    def diagnose(reason):
        print(reason, file=sys.stderr, flush=True)

    lock = B003Lock(args.db, args.device_id, args.relay_id, drive,
                    lambda action: position == action, diagnose)
    last_tap = None
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if isinstance(message, dict) and message.get("message_type") == "mock_tap":
                    last_tap = lock.card_tap(message.get("card_uid"))
                    send(last_tap)
                elif isinstance(message, dict) and message.get("message_type") == "mock_retry_tap":
                    if last_tap is not None:
                        send(last_tap)
                else:
                    lock.receive(message, send)
            except ValueError:
                print("invalid mock input", file=sys.stderr)
    finally:
        lock.close()


if __name__ == "__main__":
    main()
