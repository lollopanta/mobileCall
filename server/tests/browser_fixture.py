"""Isolated server for the browser smoke test; never uses the project database."""
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile

os.environ['SECRET_KEY'] = secrets.token_urlsafe(48)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setupDB
import uvicorn
from fastapi.staticfiles import StaticFiles

if __name__ == '__main__':
    web_dir = Path(sys.argv[1]).resolve()
    if not (web_dir / 'index.html').is_file():
        raise SystemExit('Export the web app before running this test')
    with tempfile.TemporaryDirectory(prefix='mobilecall-browser-db-') as directory:
        setupDB._DB_PATH = str(Path(directory) / 'test.db')
        setupDB.init_db()
        from api import app as api
        # Serve the exported mobile UI, keeping the production API and Socket.IO.
        api.app.router.routes = [r for r in api.app.router.routes if getattr(r, 'path', None) != '/']
        api.app.mount('/', StaticFiles(directory=str(web_dir), html=True))
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        print(json.dumps({'baseUrl': f'http://127.0.0.1:{listener.getsockname()[1]}'}), flush=True)
        # Physical sensor tests are separate; no I2C hardware is accessed here.
        server = uvicorn.Server(uvicorn.Config(api.sio_asgi_app, lifespan='off', log_level='warning'))
        server.run(sockets=[listener])
