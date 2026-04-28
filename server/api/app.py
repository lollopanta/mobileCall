import os
import sys
import asyncio
import sqlite3
import bcrypt
import jwt
import datetime
import secrets
from functools import wraps
from typing import Optional
from contextlib import asynccontextmanager

import uvicorn
import aiofiles
from fastapi import FastAPI, Request, HTTPException, Depends, Form, File, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
import socketio
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

# Add the parent directory to sys.path to resolve imports when running as a script
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env')))

from setupDB import add_new_user, get_user, update_profile_image, get_connection, set_device_config_value, start_device_pairing, get_device_pairing_for_user, get_device_pairing_by_code, complete_device_pairing, get_device_role_for_device, clear_device_pairing
from api.services.eligibility_service import EligibilityService
from api.services.image_service import ImageProcessingService
from api.services.fall_sensor import FallSensorService

# --- Configuration ---
SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-secret-change-me")
UPLOAD_FOLDER = os.path.abspath(os.path.join(os.path.dirname(__file__), 'static', 'uploads'))
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- Socket.IO Setup ---
sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins='*',
    logger=True,
    engineio_logger=True,
    ping_timeout=60,
    ping_interval=25
)

# --- Lifespan Handler ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize services
    grandparent_username = os.getenv("GRANDPARENT_USERNAME")
    asyncio.create_task(fall_sensor.start_monitoring(sio, grandparent_username))
    yield
    # Shutdown: Clean up resources if needed
    pass

# --- FastAPI App Setup ---
app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Templates
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

# --- Services ---
image_processor = ImageProcessingService()
fall_sensor = FallSensorService()
# Note: we keep these as dicts in memory as before, though for production 
# shared state between processes would need Redis/DB.
connected_users = {} # {sid: {"name": username, "family_id": family_id, "role": role, "user_id": id}}
call_sessions = {} # {session_id: {"caller_sid": sid, "viewer_sid": sid, "controller_sid": sid|None, "local_viewer_sid": sid|None, "target_user_id": int}}

# --- Helpers ---

async def get_current_user(request: Request):
    token = request.headers.get('Authorization')
    if not token:
        # Check cookies for template-based views
        token = request.cookies.get('token')
        
    if not token:
        raise HTTPException(status_code=401, detail="Token is missing!")
        
    try:
        if token.startswith('Bearer '):
            token = token[7:]
        data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        
        # Use run_in_executor for blocking DB calls
        loop = asyncio.get_event_loop()
        current_user = await loop.run_in_executor(None, get_user, data['user'])
        
        if not current_user:
            raise HTTPException(status_code=401, detail="User not found!")
        return current_user
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Token is invalid! {str(e)}")

def generate_token(username):
    payload = {
        'user': username,
        'exp': datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=24)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def apply_auth_cookies(response: JSONResponse, token: str, username: str):
    secure_cookie = os.getenv("COOKIE_SECURE", "false").lower() == "true"
    cookie_kwargs = {
        "httponly": True,
        "samesite": "lax",
        "secure": secure_cookie,
    }
    response.set_cookie(key="token", value=token, **cookie_kwargs)
    response.set_cookie(key="logged_in_user", value=username, samesite="lax", secure=secure_cookie)

def get_family_admin_info_sync(family_id):
    if not family_id:
        return {"admin_id": None, "primary_grandparent_id": None, "primary_grandparent_username": None}
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        '''
        SELECT f.admin_id, f.primary_grandparent_id, u.username AS primary_grandparent_username
        FROM families f
        LEFT JOIN users u ON u.id = f.primary_grandparent_id
        WHERE f.id = ?
        ''',
        (family_id,),
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return {"admin_id": None, "primary_grandparent_id": None, "primary_grandparent_username": None}
    return dict(row)

def is_family_admin_sync(user):
    if not user or not user.get('family_id'):
        return False
    family_info = get_family_admin_info_sync(user['family_id'])
    return family_info['admin_id'] == user['id']

def get_device_mode_sync(user, device_id: Optional[str]):
    if not user or not user.get('family_id') or not device_id:
        return {"device_mode": "standard", "pairing": None}
    if user.get("role") != "grandparent":
        return {"device_mode": "standard", "pairing": None}

    pairing_info = get_device_role_for_device(user["family_id"], user["id"], device_id)
    if pairing_info["device_role"] in ["controller", "viewer"]:
        return {
            "device_mode": pairing_info["device_role"],
            "pairing": pairing_info["pairing"],
        }

    family_info = get_family_admin_info_sync(user["family_id"])
    if family_info["primary_grandparent_id"] == user["id"]:
        return {"device_mode": "primary", "pairing": None}

    return {
        "device_mode": pairing_info["device_role"],
        "pairing": pairing_info["pairing"],
    }

def build_family_presence_sync(family_id):
    family_info = get_family_admin_info_sync(family_id)
    users_by_id = {}
    for sid, user in connected_users.items():
        if user["family_id"] != family_id:
            continue
        entry = users_by_id.get(user["user_id"])
        if not entry:
            entry = {
                "id": str(user["user_id"]),
                "name": user["name"],
                "role": user["role"],
                "user_id": user["user_id"],
                "is_primary_grandparent": user["user_id"] == family_info["primary_grandparent_id"],
                "device_modes": [],
            }
            users_by_id[user["user_id"]] = entry
        device_mode = user.get("device_mode")
        if device_mode and device_mode not in entry["device_modes"]:
            entry["device_modes"].append(device_mode)
    return list(users_by_id.values())

def get_user_by_id_sync(user_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM users WHERE id = ?', (user_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def resolve_connected_devices_for_user_sync(family_id, user_id):
    target_user = get_user_by_id_sync(user_id)
    devices = []
    for sid, data in connected_users.items():
        if data["family_id"] != family_id or data["user_id"] != user_id:
            continue
        device = {"sid": sid, **data}
        if target_user:
            device_state = get_device_mode_sync(target_user, data.get("device_id"))
            data["device_mode"] = device_state["device_mode"]
            device["device_mode"] = device_state["device_mode"]
        devices.append(device)
    return devices

def get_connected_devices_for_user_sync(family_id, user_id):
    return [
        {"sid": sid, **data}
        for sid, data in connected_users.items()
        if data["family_id"] == family_id and data["user_id"] == user_id
    ]

def get_call_session_by_sid_sync(sid):
    for session_id, session in call_sessions.items():
        if sid in [session.get("caller_sid"), session.get("viewer_sid"), session.get("controller_sid"), session.get("local_viewer_sid")]:
            return session_id, session
    return None, None

def end_call_session_sync(session_id):
    return call_sessions.pop(session_id, None)

def refresh_connected_device_modes_sync(family_id, user_id):
    resolve_connected_devices_for_user_sync(family_id, user_id)

def normalize_session_description(payload):
    if not isinstance(payload, dict):
        return None
    sdp_type = payload.get("type")
    sdp = payload.get("sdp")
    if not sdp_type or not sdp:
        return None
    return {"type": sdp_type, "sdp": sdp}

def server_debug(label, payload=None):
    if payload is None:
        print(f"[PAIR-SERVER] {label}")
        return
    print(f"[PAIR-SERVER] {label}: {payload}")

def client_prefers_html(request: Request) -> bool:
    if request.url.path.startswith("/api/"):
        return False
    accept_header = request.headers.get("accept", "")
    return "text/html" in accept_header or "*/*" in accept_header

def render_error_page(request: Request, status_code: int, title: str, message: str):
    return templates.TemplateResponse(
        request,
        "error.html",
        {
            "status_code": status_code,
            "title": title,
            "message": message,
            "logged_in_user": request.cookies.get("logged_in_user"),
        },
        status_code=status_code,
    )

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    messages = {
        401: ("Sign In Required", "You need to sign in before opening this page."),
        403: ("Access Denied", "You do not have permission to open this page."),
        404: ("Page Not Found", "The page you requested does not exist."),
        500: ("Server Error", "Something went wrong while loading this page."),
    }
    title, default_message = messages.get(exc.status_code, ("Request Error", "The request could not be completed."))
    if client_prefers_html(request):
        return render_error_page(request, exc.status_code, title, exc.detail or default_message)
    return JSONResponse(
        {"status": "unsuccessful", "message": exc.detail or default_message},
        status_code=exc.status_code,
    )

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    print(f"Unhandled server error on {request.url.path}: {exc}")
    if client_prefers_html(request):
        return render_error_page(
            request,
            500,
            "Server Error",
            "Something went wrong while loading this page.",
        )
    return JSONResponse(
        {"status": "unsuccessful", "message": "Internal server error"},
        status_code=500,
    )

# --- Web Routes ---

@app.get("/", response_class=HTMLResponse)
async def homepage(request: Request):
    return templates.TemplateResponse(request, "index.html", {"logged_in_user": request.cookies.get("logged_in_user")})

@app.get("/api/ping")
async def ping():
    return {"status": "successful", "service": "mobile-call-server"}

@app.get("/register", response_class=HTMLResponse)
async def register_view(request: Request):
    return templates.TemplateResponse(request, "auth/register.html", {"logged_in_user": request.cookies.get("logged_in_user")})

@app.post("/register")
async def register(request: Request):
    data = await request.json()
    uName = data.get('username')
    passW = data.get('password')

    if not uName or not passW:
        return JSONResponse({"status": "unsuccessful", "message": "Username and password required"}, status_code=400)

    loop = asyncio.get_event_loop()
    # Default values for simplified registration (Default role: grandparent)
    is_successful = await loop.run_in_executor(None, add_new_user, uName, passW, None, 'basic', 1, 'grandparent', None)

    if is_successful:
        token = generate_token(uName)
        response = JSONResponse({
            "status": "successful", 
            "message": f"Registration successful for {uName}",
            "token": token
        })
        apply_auth_cookies(response, token, uName)
        return response
    else:
        return JSONResponse({"status": "unsuccessful", "message": f"Registration failed, username {uName} may be taken"}, status_code=400)

@app.get("/login", response_class=HTMLResponse)
async def login_view(request: Request):
    return templates.TemplateResponse(request, "auth/login.html", {"logged_in_user": request.cookies.get("logged_in_user")})

@app.post("/login")
async def login(request: Request):
    data = await request.json()
    uName = data.get('username')
    passW = data.get('password')

    loop = asyncio.get_event_loop()
    user_row = await loop.run_in_executor(None, get_user, uName)

    if user_row is None:
        return JSONResponse({"status": "unsuccessful", "message": "Login unsuccessful, username not found"}, status_code=404)
    
    if bcrypt.checkpw(passW.encode('utf-8'), user_row['password']):
        token = generate_token(uName)
        response = JSONResponse({
            "status": "successful", 
            "message": "Login successful",
            "token": token,
            "user": {
                "id": user_row['id'],
                "username": user_row['username'],
                "role": user_row['role'],
                "family_id": user_row['family_id'],
                "is_voip_eligible": bool(user_row['is_voip_eligible'])
            }
        })
        apply_auth_cookies(response, token, uName)
        return response
    else:
        return JSONResponse({"status": "unsuccessful", "message": "Login unsuccessful, password not correct"}, status_code=401)

@app.get("/logout")
async def logout():
    response = RedirectResponse(url="/")
    response.delete_cookie("token")
    response.delete_cookie("logged_in_user")
    return response

import re
import aiohttp # Assuming we should use async for scraping, I'll add a helper or use urllib

# --- Family API ---

@app.get("/api/family/settings")
async def get_family_settings(current_user = Depends(get_current_user)):
    family_id = current_user['family_id']
    if not family_id:
        return JSONResponse({"status": "unsuccessful", "message": "No family joined"}, status_code=404)

    loop = asyncio.get_event_loop()
    def _get():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            '''
            SELECT f.google_photos_album_url, f.idle_timeout, f.primary_grandparent_id, u.username AS primary_grandparent_username
            FROM families f
            LEFT JOIN users u ON u.id = f.primary_grandparent_id
            WHERE f.id = ?
            ''',
            (family_id,),
        )
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None

    settings = await loop.run_in_executor(None, _get)
    return {"status": "successful", "settings": settings}

@app.post("/api/family/settings")
async def update_family_settings(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    album_url = data.get('google_photos_album_url')
    idle_timeout = data.get('idle_timeout', 5)
    
    loop = asyncio.get_event_loop()
    is_admin = await loop.run_in_executor(None, is_family_admin_sync, current_user)
    if not is_admin:
        return JSONResponse({"status": "unsuccessful", "message": "Only the family admin can update settings"}, status_code=403)

    family_id = current_user['family_id']
    def _update():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('UPDATE families SET google_photos_album_url = ?, idle_timeout = ? WHERE id = ?', 
                       (album_url, idle_timeout, family_id))
        conn.commit()
        conn.close()

    await loop.run_in_executor(None, _update)
    return {"status": "successful", "message": "Settings updated"}

@app.get("/api/family/photos")
async def get_family_photos(current_user = Depends(get_current_user)):
    family_id = current_user['family_id']
    if not family_id:
        return JSONResponse({"status": "unsuccessful", "message": "No family joined"}, status_code=404)

    loop = asyncio.get_event_loop()
    def _get_url():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT google_photos_album_url FROM families WHERE id = ?', (family_id,))
        row = cursor.fetchone()
        conn.close()
        return row[0] if row else None

    album_url = await loop.run_in_executor(None, _get_url)
    if not album_url:
        return {"status": "successful", "photos": []}

    # Scrape Google Photos Album
    # Simple regex for public albums: looks for base URLs of images
    try:
        import urllib.request
        def _scrape(url):
            try:
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req) as response:
                    html = response.read().decode('utf-8')
                    # Find image URLs: they usually look like https://lh3.googleusercontent.com/...
                    # We want the ones that are likely to be photos in the album
                    # This regex matches the common pattern for Google Photos image URLs in the page source
                    pattern = r'\"(https:\/\/lh3\.googleusercontent\.com\/pw\/[^\"]+)\"'
                    matches = re.findall(pattern, html)
                    # Deduplicate and limit to high-res (remove sizing params if any, add =w1920)
                    photos = []
                    seen = set()
                    for m in matches:
                        base = m.split('=')[0]
                        if base not in seen:
                            photos.append(f"{base}=w1920-h1080")
                            seen.add(base)
                    return photos
            except Exception as e:
                print(f"Scraping error: {e}")
                return []

        photos = await loop.run_in_executor(None, _scrape, album_url)
        return {"status": "successful", "photos": photos}
    except Exception as e:
        return JSONResponse({"status": "unsuccessful", "message": str(e)}, status_code=500)

@app.post("/api/family/create")
async def create_family(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    family_name = data.get('name')
    # Limit roles to caregiver or grandparent
    admin_role = data.get('role', 'grandparent')
    if admin_role not in ['caregiver', 'grandparent']:
        admin_role = 'grandparent'
    
    if not family_name:
        return JSONResponse({"status": "unsuccessful", "message": "Family name required"}, status_code=400)

    loop = asyncio.get_event_loop()
    def _create():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute('INSERT INTO families (name, admin_id) VALUES (?, ?)', (family_name, current_user['id']))
            family_id = cursor.lastrowid
            cursor.execute('UPDATE users SET family_id = ?, role = ? WHERE id = ?', (family_id, admin_role, current_user['id']))
            if admin_role == 'grandparent':
                cursor.execute('UPDATE families SET primary_grandparent_id = ? WHERE id = ?', (current_user['id'], family_id))
            conn.commit()
            return family_id
        finally:
            conn.close()

    try:
        family_id = await loop.run_in_executor(None, _create)
        if admin_role == 'grandparent':
            await loop.run_in_executor(None, set_device_config_value, "active_primary_grandparent_id", str(current_user['id']))
        return {"status": "successful", "family_id": family_id, "message": f"Family '{family_name}' created"}
    except Exception as e:
        return JSONResponse({"status": "unsuccessful", "message": str(e)}, status_code=500)

@app.get("/api/family/members")
async def get_family_members(current_user = Depends(get_current_user)):
    family_id = current_user['family_id']
    if not family_id:
        return {"status": "successful", "members": []}

    loop = asyncio.get_event_loop()
    def _get():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT admin_id, primary_grandparent_id FROM families WHERE id = ?', (family_id,))
        family_row = cursor.fetchone()
        admin_id = family_row[0] if family_row else None
        primary_grandparent_id = family_row[1] if family_row else None
        
        cursor.execute('SELECT id, username, role, profile_image FROM users WHERE family_id = ?', (family_id,))
        rows = cursor.fetchall()
        members = [{
            "id": r[0],
            "username": r[1],
            "role": r[2],
            "profile_image": r[3],
            "is_admin": (r[0] == admin_id),
            "is_primary_grandparent": (r[0] == primary_grandparent_id),
        } for r in rows]
        conn.close()
        return members

    members = await loop.run_in_executor(None, _get)
    return {"status": "successful", "members": members}

@app.post("/api/family/invite")
async def invite_member(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    target_username = data.get('username')
    
    loop = asyncio.get_event_loop()
    is_admin = await loop.run_in_executor(None, is_family_admin_sync, current_user)
    if not is_admin:
        return JSONResponse({"status": "unsuccessful", "message": "Only the family admin can invite members"}, status_code=403)

    if not current_user['family_id']:
        return JSONResponse({"status": "unsuccessful", "message": "You must create a family before inviting members"}, status_code=400)

    if not target_username:
        return JSONResponse({"status": "unsuccessful", "message": "Username required"}, status_code=400)

    def _invite():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute('SELECT id, family_id FROM users WHERE username = ?', (target_username,))
            target_user = cursor.fetchone()
            if not target_user: return "NOT_FOUND"
            
            target_id, target_family_id = target_user
            if target_family_id: return "ALREADY_IN_FAMILY"

            cursor.execute('SELECT id FROM invitations WHERE family_id = ? AND receiver_id = ? AND status = "pending"', 
                           (current_user['family_id'], target_id))
            if cursor.fetchone(): return "ALREADY_PENDING"

            cursor.execute('INSERT INTO invitations (family_id, sender_id, receiver_id) VALUES (?, ?, ?)',
                           (current_user['family_id'], current_user['id'], target_id))
            conn.commit()
            return "SUCCESS"
        finally:
            conn.close()

    res = await loop.run_in_executor(None, _invite)
    if res == "SUCCESS": return {"status": "successful", "message": f"Invitation sent to {target_username}"}
    if res == "NOT_FOUND": return JSONResponse({"status": "unsuccessful", "message": "User not found"}, status_code=404)
    return JSONResponse({"status": "unsuccessful", "message": res}, status_code=400)

@app.get("/api/notifications")
async def get_notifications(current_user = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    def _get():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT i.id, f.name, u.username, i.status, i.created_at
            FROM invitations i
            JOIN families f ON i.family_id = f.id
            JOIN users u ON i.sender_id = u.id
            WHERE i.receiver_id = ? AND i.status = "pending"
        ''', (current_user['id'],))
        invites = [{"id": row[0], "family_name": row[1], "sender_name": row[2], "status": row[3], "date": row[4]} for row in cursor.fetchall()]
        conn.close()
        return invites

    invites = await loop.run_in_executor(None, _get)
    return {"status": "successful", "notifications": invites}

@app.get("/api/family/primary-grandparent")
async def get_primary_grandparent(current_user = Depends(get_current_user)):
    family_id = current_user['family_id']
    if not family_id:
        return JSONResponse({"status": "unsuccessful", "message": "No family joined"}, status_code=404)

    loop = asyncio.get_event_loop()
    family_info = await loop.run_in_executor(None, get_family_admin_info_sync, family_id)
    return {"status": "successful", "primary_grandparent": family_info}

@app.post("/api/family/primary-grandparent")
async def set_primary_grandparent(request: Request, current_user = Depends(get_current_user)):
    if not current_user['family_id']:
        return JSONResponse({"status": "unsuccessful", "message": "No family joined"}, status_code=404)

    loop = asyncio.get_event_loop()
    is_admin = await loop.run_in_executor(None, is_family_admin_sync, current_user)
    if not is_admin:
        return JSONResponse({"status": "unsuccessful", "message": "Only the family admin can choose the primary grandparent"}, status_code=403)

    data = await request.json()
    member_id = data.get('member_id')
    if not member_id:
        return JSONResponse({"status": "unsuccessful", "message": "Member id required"}, status_code=400)

    def _set_primary():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(
                'SELECT id, username FROM users WHERE id = ? AND family_id = ? AND role = "grandparent"',
                (member_id, current_user['family_id']),
            )
            member = cursor.fetchone()
            if not member:
                return None
            cursor.execute(
                'UPDATE families SET primary_grandparent_id = ? WHERE id = ?',
                (member['id'], current_user['family_id']),
            )
            conn.commit()
            return {"id": member['id'], "username": member['username']}
        finally:
            conn.close()

    primary_member = await loop.run_in_executor(None, _set_primary)
    if not primary_member:
        return JSONResponse({"status": "unsuccessful", "message": "Choose a grandparent in your family"}, status_code=400)
    await loop.run_in_executor(None, set_device_config_value, "active_primary_grandparent_id", str(primary_member["id"]))
    return {"status": "successful", "message": "Primary grandparent updated", "primary_grandparent": primary_member}

@app.get("/api/device-pairing/status")
async def get_device_pairing_status(device_id: str, current_user = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    device_state = await loop.run_in_executor(None, get_device_mode_sync, current_user, device_id)
    pairing = device_state["pairing"]
    server_debug("device-pairing-status", {
        "user_id": current_user["id"],
        "username": current_user["username"],
        "device_id": device_id,
        "device_mode": device_state["device_mode"],
        "pairing": pairing,
    })
    return {
        "status": "successful",
        "device_mode": device_state["device_mode"],
        "pairing": {
            "status": pairing["status"],
            "pairing_code": pairing["pairing_code"],
            "viewer_paired": bool(pairing["viewer_device_id"]),
        } if pairing else None,
    }

@app.post("/api/device-pairing/start")
async def start_pairing(request: Request, current_user = Depends(get_current_user)):
    if current_user.get("role") != "grandparent" or not current_user.get("family_id"):
        return JSONResponse({"status": "unsuccessful", "message": "Only family grandparents can start device pairing"}, status_code=400)

    loop = asyncio.get_event_loop()
    data = await request.json()
    device_id = data.get("device_id")
    server_debug("start-pairing-request", {
        "user_id": current_user["id"],
        "username": current_user["username"],
        "device_id": device_id,
    })
    if not device_id:
        return JSONResponse({"status": "unsuccessful", "message": "Device id required"}, status_code=400)

    pairing_code = secrets.token_hex(3).upper()
    expires_at = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=10)).isoformat()
    await loop.run_in_executor(None, start_device_pairing, current_user["family_id"], current_user["id"], device_id, pairing_code, expires_at)
    await loop.run_in_executor(None, refresh_connected_device_modes_sync, current_user["family_id"], current_user["id"])
    server_debug("start-pairing-created", {
        "user_id": current_user["id"],
        "device_id": device_id,
        "pairing_code": pairing_code,
        "expires_at": expires_at,
    })
    return {
        "status": "successful",
        "device_mode": "viewer",
        "pairing": {
            "pairing_code": pairing_code,
            "status": "pending",
            "viewer_paired": False,
        },
    }

@app.post("/api/device-pairing/join")
async def join_pairing(request: Request, current_user = Depends(get_current_user)):
    if current_user.get("role") != "grandparent" or not current_user.get("family_id"):
        return JSONResponse({"status": "unsuccessful", "message": "Only family grandparents can join device pairing"}, status_code=400)

    loop = asyncio.get_event_loop()
    data = await request.json()
    device_id = data.get("device_id")
    pairing_code = (data.get("pairing_code") or "").strip().upper()
    server_debug("join-pairing-request", {
        "user_id": current_user["id"],
        "username": current_user["username"],
        "device_id": device_id,
        "pairing_code": pairing_code,
    })
    if not device_id or not pairing_code:
        return JSONResponse({"status": "unsuccessful", "message": "Device id and pairing code required"}, status_code=400)

    pairing = await loop.run_in_executor(None, get_device_pairing_by_code, current_user["family_id"], current_user["id"], pairing_code)
    server_debug("join-pairing-found", pairing)
    if not pairing:
        return JSONResponse({"status": "unsuccessful", "message": "Pairing code not found"}, status_code=404)
    if pairing["controller_device_id"] == device_id:
        return JSONResponse({"status": "unsuccessful", "message": "Use a second device to complete pairing"}, status_code=400)
    if pairing["viewer_device_id"] and pairing["viewer_device_id"] != device_id:
        return JSONResponse({"status": "unsuccessful", "message": "A viewer device is already paired"}, status_code=400)

    await loop.run_in_executor(None, complete_device_pairing, pairing["id"], device_id)
    await loop.run_in_executor(None, refresh_connected_device_modes_sync, current_user["family_id"], current_user["id"])
    server_debug("join-pairing-completed", {
        "user_id": current_user["id"],
        "controller_device_id": device_id,
        "pairing_id": pairing["id"],
    })
    return {
        "status": "successful",
        "device_mode": "controller",
        "pairing": {
            "pairing_code": pairing_code,
            "status": "active",
            "viewer_paired": True,
        },
    }

@app.post("/api/device-pairing/disconnect")
async def disconnect_pairing(current_user = Depends(get_current_user)):
    if current_user.get("role") != "grandparent" or not current_user.get("family_id"):
        return JSONResponse({"status": "unsuccessful", "message": "Only family grandparents can disconnect device pairing"}, status_code=400)

    loop = asyncio.get_event_loop()
    pairing = await loop.run_in_executor(None, get_device_pairing_for_user, current_user["family_id"], current_user["id"])
    if not pairing:
        return JSONResponse({"status": "unsuccessful", "message": "No paired devices found"}, status_code=404)

    await loop.run_in_executor(None, clear_device_pairing, current_user["family_id"], current_user["id"])
    await loop.run_in_executor(None, refresh_connected_device_modes_sync, current_user["family_id"], current_user["id"])
    return {"status": "successful", "message": "Device pairing disconnected"}

@app.get("/api/family/fall-logs")
async def get_fall_logs(current_user = Depends(get_current_user)):
    family_id = current_user['family_id']
    if not family_id:
        return {"status": "successful", "logs": []}

    loop = asyncio.get_event_loop()
    def _get():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT fl.id, u.username, fl.timestamp, fl.status
            FROM fall_logs fl
            JOIN users u ON fl.user_id = u.id
            WHERE fl.family_id = ?
            ORDER BY fl.timestamp DESC
        ''', (family_id,))
        logs = [{"id": r[0], "username": r[1], "timestamp": r[2], "status": r[3]} for r in cursor.fetchall()]
        conn.close()
        return logs

    logs = await loop.run_in_executor(None, _get)
    return {"status": "successful", "logs": logs}

@app.post("/api/notifications/respond")
async def respond_notification(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    invite_id = data.get('invite_id')
    response = data.get('response')
    selected_role = data.get('role')

    if response not in ['accepted', 'rejected']:
        return JSONResponse({"status": "unsuccessful", "message": "Invalid response"}, status_code=400)
    if response == 'accepted' and selected_role not in ['caregiver', 'grandparent']:
        return JSONResponse({"status": "unsuccessful", "message": "Choose caregiver or grandparent before accepting"}, status_code=400)

    loop = asyncio.get_event_loop()
    def _respond():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute('SELECT family_id FROM invitations WHERE id = ? AND receiver_id = ?', (invite_id, current_user['id']))
            invite = cursor.fetchone()
            if not invite:
                return {"success": False}
            family_id = invite[0]
            cursor.execute('UPDATE invitations SET status = ? WHERE id = ?', (response, invite_id))
            auto_assigned_primary = False
            if response == 'accepted':
                cursor.execute(
                    'UPDATE users SET family_id = ?, role = ? WHERE id = ?',
                    (family_id, selected_role, current_user['id']),
                )
                if selected_role == 'grandparent':
                    cursor.execute('SELECT primary_grandparent_id FROM families WHERE id = ?', (family_id,))
                    family_row = cursor.fetchone()
                    if family_row and not family_row['primary_grandparent_id']:
                        cursor.execute(
                            'UPDATE families SET primary_grandparent_id = ? WHERE id = ?',
                            (current_user['id'], family_id),
                        )
                        auto_assigned_primary = True
            conn.commit()
            return {
                "success": True,
                "family_id": family_id,
                "auto_assigned_primary": auto_assigned_primary,
            }
        finally:
            conn.close()

    result = await loop.run_in_executor(None, _respond)
    if result["success"] and response == 'accepted' and selected_role == 'grandparent' and result["auto_assigned_primary"]:
        await loop.run_in_executor(None, set_device_config_value, "active_primary_grandparent_id", str(current_user['id']))
    if result["success"]:
        return {"status": "successful", "message": f"Invitation {response}"}
    return JSONResponse({"status": "unsuccessful", "message": "Invitation not found"}, status_code=404)

# --- Profile and Image API ---

@app.get("/api/profile")
async def get_profile(current_user = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    is_admin = await loop.run_in_executor(None, is_family_admin_sync, current_user)
    family_info = await loop.run_in_executor(None, get_family_admin_info_sync, current_user.get('family_id'))
    user_data = dict(current_user)
    user_data['is_family_admin'] = is_admin
    user_data['is_primary_grandparent'] = family_info['primary_grandparent_id'] == current_user['id']
    user_data['family_primary_grandparent_id'] = family_info['primary_grandparent_id']
    user_data['family_primary_grandparent_username'] = family_info['primary_grandparent_username']
    return {"status": "successful", "user": user_data}

@app.post("/api/profile/update")
async def update_profile(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    role = data.get('role')
    age = data.get('age')
    
    if role and role not in ['caregiver', 'grandparent']:
        return JSONResponse({"status": "unsuccessful", "message": "Invalid role. Must be caregiver or grandparent."}, status_code=400)
    if role and current_user.get('family_id'):
        return JSONResponse({"status": "unsuccessful", "message": "Role is chosen when creating or joining a family"}, status_code=403)
    
    loop = asyncio.get_event_loop()
    def _update():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            if role: cursor.execute('UPDATE users SET role = ? WHERE id = ?', (role, current_user['id']))
            if age: cursor.execute('UPDATE users SET age = ? WHERE id = ?', (age, current_user['id']))
            conn.commit()
        finally:
            conn.close()
    await loop.run_in_executor(None, _update)
    return {"status": "successful", "message": "Profile updated"}

@app.post("/api/profile/upload-direct")
async def upload_profile_photo_direct(image: UploadFile = File(...), current_user = Depends(get_current_user)):
    username = current_user['username']
    extension = image.filename.split('.')[-1] if '.' in image.filename else 'jpg'
    filename = f"{username}_profile.{extension}"
    output_path = os.path.join(UPLOAD_FOLDER, filename)
    
    async with aiofiles.open(output_path, "wb") as buffer:
        await buffer.write(await image.read())

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, update_profile_image, username, f"/static/uploads/{filename}")
        return {
            "status": "successful",
            "message": "Profile image updated",
            "profile_image": f"/static/uploads/{filename}"
        }
    except Exception as e:
        return JSONResponse({"status": "unsuccessful", "message": str(e)}, status_code=500)

@app.post("/upload-image")
async def upload_image(
    image: UploadFile = File(...),
    username: Optional[str] = Form(default=None),
    current_user = Depends(get_current_user),
):
    effective_username = current_user['username']
    if username and username != effective_username:
        return JSONResponse({"status": "unsuccessful", "message": "Username mismatch"}, status_code=403)

    filename = secure_filename(f"{effective_username}_group_{image.filename}")
    temp_path = os.path.join(UPLOAD_FOLDER, filename)
    
    import aiofiles
    async with aiofiles.open(temp_path, "wb") as buffer:
        await buffer.write(await image.read())

    loop = asyncio.get_event_loop()
    try:
        faces, img_shape = await loop.run_in_executor(None, image_processor.detect_faces, temp_path)
        return {
            "status": "successful",
            "message": f"Detected {len(faces)} faces",
            "faces": faces,
            "image_id": filename
        }
    except Exception as e:
        return JSONResponse({"status": "unsuccessful", "message": str(e)}, status_code=500)

@app.post("/finalize-crop")
async def finalize_crop(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    image_id = data.get('image_id')
    face = data.get('face')

    if not image_id or not face:
        return JSONResponse({"status": "unsuccessful", "message": "Missing data"}, status_code=400)

    username = current_user['username']
    input_path = os.path.join(UPLOAD_FOLDER, image_id)
    output_filename = f"{username}_profile.jpg"
    output_path = os.path.join(UPLOAD_FOLDER, output_filename)

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, image_processor.crop_face, input_path, face['x'], face['y'], face['w'], face['h'], output_path)
        await loop.run_in_executor(None, update_profile_image, username, f"/static/uploads/{output_filename}")
        return {
            "status": "successful",
            "message": "Profile image updated",
            "profile_image": f"/static/uploads/{output_filename}"
        }
    except Exception as e:
        return JSONResponse({"status": "unsuccessful", "message": str(e)}, status_code=500)

# --- Template Pages ---

@app.get("/user/{username}", response_class=HTMLResponse)
async def user_profile_view(request: Request, username: str):
    logged_user = request.cookies.get("logged_in_user")
    if logged_user != username:
        return RedirectResponse(url="/login")
    
    loop = asyncio.get_event_loop()
    user_data = await loop.run_in_executor(None, get_user, username)
    return templates.TemplateResponse(request, "profile.html", {"user": user_data, "logged_in_user": logged_user})

@app.get("/family/create", response_class=HTMLResponse)
async def create_family_view(request: Request):
    logged_user = request.cookies.get("logged_in_user")
    if not logged_user: return RedirectResponse(url="/login")
    return templates.TemplateResponse(request, "create_family.html", {"logged_in_user": logged_user})

@app.get("/family/settings", response_class=HTMLResponse)
async def family_settings_view(request: Request):
    loop = asyncio.get_event_loop()
    try:
        current_user = await get_current_user(request)
    except HTTPException:
        response = RedirectResponse(url="/login", status_code=303)
        response.delete_cookie("token")
        response.delete_cookie("logged_in_user")
        return response

    user_data = await loop.run_in_executor(None, get_user, current_user['username'])
    if not user_data:
        response = RedirectResponse(url="/login", status_code=303)
        response.delete_cookie("token")
        response.delete_cookie("logged_in_user")
        return response

    if not user_data['family_id']:
        return RedirectResponse(url="/family/create", status_code=303)

    is_admin = await loop.run_in_executor(None, is_family_admin_sync, user_data)
    family_info = await loop.run_in_executor(None, get_family_admin_info_sync, user_data['family_id'])
    return templates.TemplateResponse(
        request,
        "family_settings.html",
        {
            "user": user_data,
            "logged_in_user": user_data["username"],
            "is_family_admin": is_admin,
            "family_info": family_info,
        },
    )

@app.get("/notifications", response_class=HTMLResponse)
async def notifications_page(request: Request):
    logged_user = request.cookies.get("logged_in_user")
    if not logged_user: return RedirectResponse(url="/login")
    return templates.TemplateResponse(request, "notifications.html", {"logged_in_user": logged_user})

# --- Socket.IO Event Handlers ---

@sio.on('connect')
async def handle_connect(sid, environ):
    print(f"[CONNECT] ID: {sid}")

@sio.on('join')
async def handle_join(sid, data):
    token = data.get('token')
    if not token: return
    try:
        decoded = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        username = decoded['user']
        device_id = data.get('deviceId')
        loop = asyncio.get_event_loop()
        user_row = await loop.run_in_executor(None, get_user, username)
        if not user_row or not user_row['family_id']: return

        family_id = user_row['family_id']
        room = f"family_{family_id}"
        await sio.enter_room(sid, room)
        device_state = await loop.run_in_executor(None, get_device_mode_sync, user_row, device_id)
        connected_users[sid] = {
            "name": username,
            "family_id": family_id,
            "role": user_row['role'],
            "user_id": user_row['id'],
            "device_id": device_id,
            "device_mode": device_state["device_mode"],
        }
        server_debug("socket-join", {
            "sid": sid,
            "username": username,
            "user_id": user_row["id"],
            "device_id": device_id,
            "device_mode": device_state["device_mode"],
        })
        print(f"[JOIN] {username} joined room {room}")

        family_members = await loop.run_in_executor(None, build_family_presence_sync, family_id)
        await sio.emit('user-list', family_members, room=room)
    except Exception as e:
        print(f"Join error: {e}")

@sio.on('request-user-list')
async def handle_request_user_list(sid, data):
    user_info = connected_users.get(sid)
    if user_info:
        family_id = user_info['family_id']
        loop = asyncio.get_event_loop()
        family_members = await loop.run_in_executor(None, build_family_presence_sync, family_id)
        await sio.emit('user-list', family_members, to=sid)

@sio.on('offer')
async def handle_offer(sid, data):
    user_info = connected_users.get(sid)
    sender_name = user_info['name'] if user_info else "Unknown"
    target_to = data.get('to')
    target_user_id = data.get('toUserId')
    offer_payload = normalize_session_description(data.get('offer'))
    is_video = bool(data.get('isVideo'))
    auto_accept = bool(data.get('autoAccept')) and is_video and user_info and user_info.get("name") == "lollopanta" and user_info.get("role") == "caregiver"

    if not user_info:
        return
    if not offer_payload:
        print(f"[OFFER] Invalid SDP payload from {sender_name}: {data.get('offer')}")
        return

    if target_user_id:
        loop = asyncio.get_event_loop()
        target_user_id_int = int(target_user_id)
        devices = await loop.run_in_executor(None, resolve_connected_devices_for_user_sync, user_info["family_id"], target_user_id_int)
        caller_devices = await loop.run_in_executor(None, resolve_connected_devices_for_user_sync, user_info["family_id"], user_info["user_id"])
        server_debug("offer-target-user", {
            "from_sid": sid,
            "from_name": sender_name,
            "target_user_id": target_user_id_int,
            "is_video": is_video,
            "auto_accept": auto_accept,
            "devices": [
                {
                    "sid": device["sid"],
                    "device_id": device.get("device_id"),
                    "device_mode": device.get("device_mode"),
                    "username": device.get("name"),
                }
                for device in devices
            ],
            "caller_devices": [
                {
                    "sid": device["sid"],
                    "device_id": device.get("device_id"),
                    "device_mode": device.get("device_mode"),
                    "username": device.get("name"),
                }
                for device in caller_devices
            ],
        })
        if not devices:
            await sio.emit('call-rejected', {'from': sid}, to=sid)
            return

        viewer_device = next((d for d in devices if d.get("device_mode") == "viewer"), None)
        controller_device = next((d for d in devices if d.get("device_mode") == "controller"), None)
        fallback_device = next((d for d in devices if d["sid"] != sid), devices[0])
        controller_sid = controller_device["sid"] if controller_device else fallback_device["sid"]
        viewer_sid = viewer_device["sid"] if viewer_device else None
        if viewer_sid == controller_sid:
            viewer_sid = None
        caller_viewer_device = next(
            (
                d for d in caller_devices
                if d.get("device_mode") == "viewer" and d["sid"] != sid
            ),
            None,
        )
        local_viewer_sid = caller_viewer_device["sid"] if caller_viewer_device else None
        if local_viewer_sid == controller_sid:
            local_viewer_sid = None
        session_id = secrets.token_hex(8)
        call_sessions[session_id] = {
            "caller_sid": sid,
            "viewer_sid": viewer_sid,
            "controller_sid": controller_sid,
            "local_viewer_sid": local_viewer_sid,
            "target_user_id": target_user_id_int,
        }
        server_debug("offer-routing", {
            "session_id": session_id,
            "caller_sid": sid,
            "controller_sid": controller_sid,
            "viewer_sid": viewer_sid,
            "local_viewer_sid": local_viewer_sid,
            "is_video": is_video,
        })
        await sio.emit('call-session-started', {
            'sessionId': session_id,
            'viewerSid': viewer_sid,
            'controllerSid': controller_sid,
            'localViewerSid': local_viewer_sid,
            'isVideo': is_video,
        }, to=sid)

        await sio.emit('offer', {
            'from': sid,
            'fromName': sender_name,
            'offer': offer_payload,
            'isVideo': is_video,
            'autoAccept': auto_accept,
            'sessionId': session_id,
            'callerViewerSid': local_viewer_sid,
        }, to=controller_sid)

        if viewer_sid:
            await sio.emit('call-controller-state', {
                'sessionId': session_id,
                'phase': 'ringing',
                'callerName': sender_name,
                'isVideo': is_video,
            }, to=viewer_sid)
        if local_viewer_sid:
            await sio.emit('call-controller-state', {
                'sessionId': session_id,
                'phase': 'ringing',
                'callerName': connected_users.get(controller_sid, {}).get("name", sender_name),
                'isVideo': is_video,
            }, to=local_viewer_sid)
        return

    await sio.emit('offer', {
        'from': sid,
        'fromName': sender_name,
        'offer': offer_payload,
        'isVideo': is_video,
        'autoAccept': auto_accept,
        'sessionId': data.get('sessionId'),
    }, to=target_to)

@sio.on('answer')
async def handle_answer(sid, data):
    session_id = data.get('sessionId')
    answer_payload = normalize_session_description(data.get('answer'))
    server_debug("answer-received", {
        "sid": sid,
        "session_id": session_id,
        "to": data.get("to"),
        "answer_type": data.get("answer", {}).get("type") if isinstance(data.get("answer"), dict) else None,
        "answer_length": len(data.get("answer", {}).get("sdp", "")) if isinstance(data.get("answer"), dict) and data.get("answer", {}).get("sdp") else 0,
    })
    if not answer_payload:
        print(f"[ANSWER] Invalid SDP payload from {sid}: {data.get('answer')}")
        return
    if session_id and session_id in call_sessions:
        session = call_sessions[session_id]
        if session.get("controller_sid"):
            await sio.emit('call-controller-state', {
                'sessionId': session_id,
                'phase': 'connected',
                'callerName': connected_users.get(session["caller_sid"], {}).get("name", "Caregiver"),
            }, to=session["controller_sid"])
        if session.get("viewer_sid"):
            await sio.emit('call-controller-state', {
                'sessionId': session_id,
                'phase': 'connected',
                'callerName': connected_users.get(session["caller_sid"], {}).get("name", "Caregiver"),
            }, to=session["viewer_sid"])
        if session.get("local_viewer_sid"):
            await sio.emit('call-controller-state', {
                'sessionId': session_id,
                'phase': 'connected',
                'callerName': connected_users.get(session["caller_sid"], {}).get("name", "Caregiver"),
            }, to=session["local_viewer_sid"])
    await sio.emit('answer', {'from': sid, 'answer': answer_payload, 'sessionId': session_id}, to=data.get('to'))

@sio.on('ice-candidate')
async def handle_ice_candidate(sid, data):
    await sio.emit('ice-candidate', {'from': sid, 'candidate': data.get('candidate')}, to=data.get('to'))

@sio.on('call-rejected')
async def handle_call_rejected(sid, data):
    session_id = data.get('sessionId')
    if session_id and session_id in call_sessions:
        session = end_call_session_sync(session_id)
        if not session:
            return
        for target_sid in [session.get("caller_sid"), session.get("viewer_sid"), session.get("controller_sid"), session.get("local_viewer_sid")]:
            if target_sid and target_sid != sid:
                await sio.emit('call-rejected', {'from': sid, 'sessionId': session_id}, to=target_sid)
        return
    await sio.emit('call-rejected', {'from': sid}, to=data.get('to'))

@sio.on('end-call')
async def handle_end_call(sid, data):
    session_id = data.get('sessionId')
    server_debug("end-call", {
        "sid": sid,
        "session_id": session_id,
        "to": data.get("to"),
    })
    if session_id and session_id in call_sessions:
        session = end_call_session_sync(session_id)
        if not session:
            return
        for target_sid in [session.get("caller_sid"), session.get("viewer_sid"), session.get("controller_sid"), session.get("local_viewer_sid")]:
            if target_sid and target_sid != sid:
                await sio.emit('end-call', {'from': sid, 'sessionId': session_id}, to=target_sid)
        return
    await sio.emit('end-call', {'from': sid}, to=data.get('to'))

@sio.on('disconnect')
async def handle_disconnect(sid):
    user_info = connected_users.pop(sid, None)
    if user_info:
        server_debug("socket-disconnect", {
            "sid": sid,
            "username": user_info.get("name"),
            "user_id": user_info.get("user_id"),
            "device_id": user_info.get("device_id"),
            "device_mode": user_info.get("device_mode"),
        })
        session_id, session = get_call_session_by_sid_sync(sid)
        if session_id and session:
            end_call_session_sync(session_id)
            for target_sid in [session.get("caller_sid"), session.get("viewer_sid"), session.get("controller_sid"), session.get("local_viewer_sid")]:
                if target_sid and target_sid != sid:
                    await sio.emit('end-call', {'from': sid, 'sessionId': session_id}, to=target_sid)
        family_id = user_info['family_id']
        room = f"family_{family_id}"
        family_members = build_family_presence_sync(family_id)
        await sio.emit('user-list', family_members, room=room)

# Mount static files after all routes are defined
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")

# Socket.IO ASGI App wrapper
sio_asgi_app = socketio.ASGIApp(sio, app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.app:sio_asgi_app", host="0.0.0.0", port=3000, reload=False)
