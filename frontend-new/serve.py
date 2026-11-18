#!/usr/bin/env python3
"""Local test server for SoundScape that disables browser caching.
Usage (from this folder):  python serve.py   ->  http://localhost:8080"""
import http.server, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f'SoundScape running on http://localhost:{port}  (Ctrl+C to stop)')
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
