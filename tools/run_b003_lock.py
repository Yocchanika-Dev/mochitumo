"""Connect B003Lock to an RC-S330 and a trusted USB serial link."""

import argparse
import importlib
import json
import queue
import sys
import threading
import time

from b003_lock import B003Lock


def diagnostic(reason):
    print(reason, file=sys.stderr, flush=True)


def scan_cards(reader, cards, stopped):
    def on_connect(tag):
        idm = getattr(tag, "idm", None)
        if idm is not None and len(idm) == 8:
            try:
                cards.put_nowait(bytes(idm).hex())
            except queue.Full:
                diagnostic("card_queue_full")
        return True  # nfcpy waits for removal before polling again.

    try:
        while not stopped.is_set():
            reader.connect(rdwr={"targets": ["212F", "424F"], "on-connect": on_connect,
                                 "iterations": 1, "interval": 0.2},
                           terminate=stopped.is_set)
    except Exception:
        diagnostic("card_reader_unavailable")
        stopped.set()


def run(port, lock, cards, stopped):
    buffer = bytearray()
    dropping = False
    pending = None
    attempts = 0
    retry_at = 0

    def send(line):
        data = line.encode("utf-8")
        if port.write(data) != len(data):
            raise OSError("incomplete serial write")

    while not stopped.is_set():
        for byte in port.read(port.in_waiting or 1):
            if byte != 10:
                if not dropping:
                    buffer.append(byte)
                    if len(buffer) > 1024:
                        buffer.clear()
                        dropping = True
                continue
            if dropping:
                dropping = False
                continue
            try:
                message = json.loads(buffer)
            except (ValueError, UnicodeError):
                continue
            finally:
                buffer.clear()
            if (pending is not None and isinstance(message, dict)
                    and message.get("v") == 1
                    and message.get("message_type") == "card_tap_result"
                    and message.get("client_request_id") == pending[1]
                    and all(message.get(key) == value for key, value in lock.target.items())):
                pending = None
            lock.receive(message, send)

        if pending is None:
            try:
                frame = lock.card_tap(cards.get_nowait())
            except queue.Empty:
                continue
            pending = (frame, json.loads(frame)["client_request_id"])
            attempts = 0
            retry_at = 0
        if time.monotonic() >= retry_at:
            if attempts == 3:
                pending = None
                diagnostic("card_tap_result_timeout")
            else:
                send(pending[0])
                attempts += 1
                retry_at = time.monotonic() + 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="B003-side serial port")
    parser.add_argument("--db", required=True, help="B003-only persistent command ledger")
    parser.add_argument("--device-id", default="BIKE03")
    parser.add_argument("--relay-id", default="RELAY01")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--reader", default="usb:054c:02e1")
    parser.add_argument("--driver", required=True,
                        help="local module exposing drive(action) and confirms_position(action)")
    args = parser.parse_args()
    import nfc
    import serial

    driver = importlib.import_module(args.driver)
    lock = B003Lock(args.db, args.device_id, args.relay_id, driver.drive,
                    driver.confirms_position, diagnostic)
    stopped = threading.Event()
    cards = queue.Queue(maxsize=1)
    try:
        with nfc.ContactlessFrontend(args.reader) as reader, serial.Serial(
            args.port, args.baud, timeout=0.1, write_timeout=1,
        ) as port:
            worker = threading.Thread(target=scan_cards, args=(reader, cards, stopped))
            worker.start()
            try:
                run(port, lock, cards, stopped)
            finally:
                stopped.set()
                worker.join()
    except KeyboardInterrupt:
        return 0
    finally:
        lock.close()
    return 1  # Reader stopped unexpectedly.


if __name__ == "__main__":
    sys.exit(main())
