#!/usr/bin/env python3
"""StudyVault optional self-hosted sync server. Python standard library only.
Run: STUDYVAULT_SYNC_TOKEN=change-me python3 server.py
Default: http://127.0.0.1:8787
"""
import json, os, sqlite3, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST=os.getenv('STUDYVAULT_HOST','127.0.0.1')
PORT=int(os.getenv('STUDYVAULT_PORT','8787'))
TOKEN=os.getenv('STUDYVAULT_SYNC_TOKEN','change-me')
DB=os.getenv('STUDYVAULT_DB','studyvault-sync.sqlite3')
conn=sqlite3.connect(DB, check_same_thread=False)
conn.execute('CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), updated_at REAL NOT NULL, payload TEXT NOT NULL)')
conn.commit()

def json_bytes(obj): return json.dumps(obj, ensure_ascii=False).encode('utf-8')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): print('%s - %s' % (self.address_string(), fmt%args))
    def send_json(self, code, obj):
        body=json_bytes(obj); self.send_response(code); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(body))); self.send_header('Cache-Control','no-store'); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Vary','Origin'); self.end_headers(); self.wfile.write(body)
    def authorized(self):
        return self.headers.get('Authorization','') == 'Bearer ' + TOKEN
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','Content-Type, Authorization'); self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); self.end_headers()
    def do_GET(self):
        if self.path == '/api/health': return self.send_json(200, {'ok':True,'service':'StudyVault Sync','time':time.time()})
        if self.path != '/api/sync/pull': return self.send_json(404, {'ok':False,'error':'not_found'})
        if not self.authorized(): return self.send_json(401, {'ok':False,'error':'unauthorized'})
        row=conn.execute('SELECT updated_at,payload FROM vault WHERE id=1').fetchone()
        return self.send_json(200, {'ok':True,'updatedAt':row[0] if row else 0,'payload':json.loads(row[1]) if row else None})
    def do_POST(self):
        if self.path != '/api/sync/push': return self.send_json(404, {'ok':False,'error':'not_found'})
        if not self.authorized(): return self.send_json(401, {'ok':False,'error':'unauthorized'})
        try:
            length=int(self.headers.get('Content-Length','0')); data=json.loads(self.rfile.read(length) or '{}'); payload=data.get('payload')
            if not isinstance(payload,dict): raise ValueError('payload must be an object')
            updated=float(data.get('updatedAt') or time.time())
            old=conn.execute('SELECT updated_at FROM vault WHERE id=1').fetchone()
            if old and updated < old[0]: return self.send_json(409, {'ok':False,'error':'stale_payload','updatedAt':old[0]})
            conn.execute('INSERT INTO vault(id,updated_at,payload) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload',(updated,json.dumps(payload,ensure_ascii=False)))
            conn.commit(); return self.send_json(200, {'ok':True,'updatedAt':updated})
        except Exception as e: return self.send_json(400, {'ok':False,'error':str(e)})

print(f'StudyVault Sync listening on http://{HOST}:{PORT}')
print('Set STUDYVAULT_SYNC_TOKEN before exposing this server beyond your own machine/network.')
ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
