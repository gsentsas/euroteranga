#!/usr/bin/env python3
import socket
import struct

HOST = "127.0.0.1"
PORT = 3310

def scan(payload: bytes) -> str:
    with socket.create_connection((HOST, PORT), timeout=5) as sock:
        sock.settimeout(10)
        sock.sendall(b"zINSTREAM\0")
        sock.sendall(struct.pack(">I", len(payload)))
        sock.sendall(payload)
        sock.sendall(struct.pack(">I", 0))
        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\0" in chunk:
                break
        return b"".join(chunks).split(b"\0", 1)[0].decode("utf-8", "replace")

clean = scan(b"EURO TERANGA harmless scanner health probe\n")
eicar = scan(b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")

if not clean.endswith("OK"):
    raise SystemExit(f"clean probe failed: {clean}")
if "FOUND" not in eicar:
    raise SystemExit(f"EICAR probe failed: {eicar}")

print("CLAMAV_INSTREAM=PASS")
