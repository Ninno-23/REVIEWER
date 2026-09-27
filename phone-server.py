#!/usr/bin/env python3
"""Serve StudyVault on your Wi-Fi so your phone can open it.

Usage:
  python3 phone-server.py

Then open the printed URL on your phone (same Wi-Fi), or scan the QR in the page.
Binds to 0.0.0.0 so LAN devices can connect. For home study only — not public internet.
"""
from __future__ import annotations
import http.server, socket, socketserver, os, sys

PORT = int(os.getenv("STUDYVAULT_PHONE_PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Helpful for local PWA-ish use; still local-first
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    os.chdir(ROOT)
    ip = lan_ip()
    url = f"http://{ip}:{PORT}/"
    print("")
    print("  StudyVault phone server")
    print("  -----------------------")
    print(f"  Folder : {ROOT}")
    print(f"  Local  : http://127.0.0.1:{PORT}/")
    print(f"  Phone  : {url}")
    print("")
    print("  1. Phone + computer on the SAME Wi-Fi")
    print("  2. Open the Phone URL above (or scan QR in Settings after opening)")
    print("  3. Keep this terminal open while you study")
    print("")
    print("  Press Ctrl+C to stop.")
    print("")
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
