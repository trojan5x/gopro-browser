#!/usr/bin/env python3
"""
GoPro Browser Proxy Server
===========================
Serves gopro-browser.html and proxies all /proxy/* requests
to the GoPro at 172.27.123.51:8080 — bypasses browser CORS.

Usage:
    python3 gopro-proxy.py

Then open: http://localhost:8765
"""

import http.server
import urllib.request
import urllib.error
import urllib.parse
import os
import sys
import json
import socket
import subprocess
import tempfile
from pathlib import Path

PORT       = 8765
GOPRO_BASE = "http://172.27.123.51:8080"
HTML_FILE  = Path(__file__).parent / "gopro-browser.html"

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def has_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=3)
        return True
    except Exception:
        return False


class GoProProxyHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        try:
            status = str(args[1]) if len(args) > 1 else "?"
            raw    = str(args[0]) if args else "?"
            parts  = raw.split()
            path   = parts[1] if len(parts) > 1 else raw
            color  = "\033[32m" if status.startswith("2") else "\033[31m"
            reset  = "\033[0m"
            print(f"  {color}{status}{reset}  {path}")
        except Exception:
            pass

    def send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        path = self.path

        if path in ("/", "/index.html", "/gopro-browser.html"):
            self._serve_html()
            return

        if path == "/info" or path.startswith("/info?"):
            self._serve_info()
            return

        if path.startswith("/clip"):
            self._serve_clip(path)
            return

        if path == "/proxy-download":
            self._serve_proxy_script()
            return

        if path.startswith("/proxy/"):
            gopro_path = path[len("/proxy"):]
            self._proxy(gopro_path)
            return

        self._json_error(404, "not found")

    # ── Static HTML ──────────────────────────────────────────────────

    def _serve_html(self):
        if not HTML_FILE.exists():
            self._json_error(404, f"gopro-browser.html not found at {HTML_FILE}")
            return
        content = HTML_FILE.read_bytes()
        self.send_response(200)
        self.send_cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # ── /info ────────────────────────────────────────────────────────

    def _serve_info(self):
        data = json.dumps({
            "local_url": f"http://{get_local_ip()}:{PORT}",
            "gopro_url": GOPRO_BASE,
            "port": PORT,
            "ffmpeg": has_ffmpeg(),
        }).encode()
        self.send_response(200)
        self.send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── /clip  (ffmpeg clip extraction) ─────────────────────────────

    def _serve_clip(self, path):
        parsed = urllib.parse.urlparse(path)
        params = urllib.parse.parse_qs(parsed.query)

        gopro_path = params.get("path", [""])[0]      # e.g. 100GOPRO/GX010319.MP4
        start      = float(params.get("start", ["0"])[0])
        duration   = float(params.get("duration", ["30"])[0])

        if not gopro_path:
            self._json_error(400, "Missing path parameter")
            return

        input_url = f"{GOPRO_BASE}/videos/DCIM/{gopro_path}"
        clip_name = "clip_" + gopro_path.split("/")[-1]
        tmp_path  = None

        try:
            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                tmp_path = tmp.name

            cmd = [
                "ffmpeg", "-y",
                "-ss", str(start),
                "-i", input_url,
                "-t", str(duration),
                "-c", "copy",
                tmp_path,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=300)

            if result.returncode != 0:
                self._json_error(500, result.stderr.decode()[:300])
                return

            with open(tmp_path, "rb") as f:
                data = f.read()

            self.send_response(200)
            self.send_cors()
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'attachment; filename="{clip_name}"')
            self.end_headers()
            self.wfile.write(data)

        except subprocess.TimeoutExpired:
            self._json_error(504, "ffmpeg timed out")
        except Exception as e:
            self._json_error(500, str(e))
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    # ── /proxy-download → serve this script ─────────────────────────

    def _serve_proxy_script(self):
        script = Path(__file__)
        content = script.read_bytes()
        self.send_response(200)
        self.send_cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Disposition", 'attachment; filename="gopro-proxy.py"')
        self.end_headers()
        self.wfile.write(content)

    # ── /proxy/* → GoPro ────────────────────────────────────────────

    def _proxy(self, gopro_path):
        url = GOPRO_BASE + gopro_path
        try:
            headers = {"User-Agent": "GoProBrowser/1.0"}
            range_header = self.headers.get("Range")
            if range_header:
                headers["Range"] = range_header

            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                status        = resp.status
                content_type  = resp.headers.get("Content-Type", "application/octet-stream")
                content_len   = resp.headers.get("Content-Length")
                content_range = resp.headers.get("Content-Range")
                accept_ranges = resp.headers.get("Accept-Ranges", "bytes")

                self.send_response(status)
                self.send_cors()
                self.send_header("Content-Type", content_type)
                self.send_header("Accept-Ranges", accept_ranges)
                if content_len:   self.send_header("Content-Length", content_len)
                if content_range: self.send_header("Content-Range", content_range)
                self.end_headers()

                chunk = 256 * 1024
                while True:
                    data = resp.read(chunk)
                    if not data:
                        break
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        break

        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except (urllib.error.URLError, TimeoutError, ConnectionRefusedError, OSError) as e:
            msg = json.dumps({"error": "GoPro unreachable", "detail": str(e)}).encode()
            self.send_response(503)
            self.send_cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    # ── helpers ──────────────────────────────────────────────────────

    def _json_error(self, code, msg):
        data = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    local_ip   = get_local_ip()
    ffmpeg_ok  = has_ffmpeg()
    html_ok    = HTML_FILE.exists()

    if not html_ok:
        print(f"\n  \033[33m⚠  gopro-browser.html not found at {HTML_FILE}\033[0m\n")

    print(f"""
  \033[1mGoPro Browser Proxy\033[0m
  ─────────────────────────────────────────
  Local     →  \033[36mhttp://localhost:{PORT}\033[0m
  Network   →  \033[36mhttp://{local_ip}:{PORT}\033[0m
  GoPro     →  \033[33m{GOPRO_BASE}\033[0m
  ffmpeg    →  {'✓ available (clip export enabled)' if ffmpeg_ok else '✗ not found  (brew install ffmpeg)'}
  ─────────────────────────────────────────
  Steps:
    1. Plug in GoPro Hero 10 via USB-C
    2. Press the power button on the camera
    3. Open  http://localhost:{PORT}  in Chrome
    4. Click Connect

  Press Ctrl+C to stop.
  ─────────────────────────────────────────
""")

    server = http.server.ThreadingHTTPServer(("", PORT), GoProProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n  Stopped. Bye!\n")
        server.server_close()


if __name__ == "__main__":
    main()
