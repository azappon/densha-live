"""Local dev server for ./public.

Run:  uv run --no-project python -I tools/serve.py [port]
Then open http://localhost:8080 (add ?at=08:15 to view another Japan time).
"""
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'public'


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json',
        '.json': 'application/json', '.svg': 'image/svg+xml',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        text = fmt % args
        if ' 4' in text or ' 5' in text:
            super().log_message('%s', text)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with Server(('0.0.0.0', port), Handler) as httpd:
        print(f'Serving {ROOT} on http://localhost:{port}')
        httpd.serve_forever()
