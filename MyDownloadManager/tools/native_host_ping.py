"""Talks to an installed native messaging host exactly like a browser does (length-prefixed JSON over stdio).

Usage: python tools/native_host_ping.py <path-to-host-exe> [json-message]
Prints the reply and exits 0 when the host answered with ok=true.
"""
import json
import struct
import subprocess
import sys

host = sys.argv[1]
message = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {"type": "ping"}
proc = subprocess.Popen([host, "chrome-extension://jepeaacjobbkicoofllleimejjcjebge/"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
body = json.dumps(message).encode("utf-8")
proc.stdin.write(struct.pack("<I", len(body)) + body)
proc.stdin.flush()
header = proc.stdout.read(4)
if len(header) != 4:
    print("no reply from host", file=sys.stderr)
    sys.exit(2)
reply = json.loads(proc.stdout.read(struct.unpack("<I", header)[0]).decode("utf-8"))
proc.stdin.close()
proc.wait(timeout=30)
print(json.dumps(reply))
sys.exit(0 if reply.get("ok") else 1)
