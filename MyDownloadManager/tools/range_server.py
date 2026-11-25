"""Minimal threaded HTTP server with single-range support, used by the Windows CI smoke test.

Usage: python tools/range_server.py <directory> <port>
Serves files from <directory> on 127.0.0.1 only.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return None
        size = os.path.getsize(path)
        f = open(path, "rb")
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        if m and m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
            if start >= size:
                f.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            f.seek(start)
            self._remaining = end - start + 1
        else:
            self.send_response(200)
            self._remaining = size
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(self._remaining))
        self.send_header("ETag", f'"{int(os.path.getmtime(path))}-{size}"')
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        remaining = self._remaining
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    directory, port = sys.argv[1], int(sys.argv[2])
    handler = lambda *a, **kw: RangeHandler(*a, directory=directory, **kw)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
