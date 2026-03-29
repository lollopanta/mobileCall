import os
import sys
import asyncio
import sqlite3
import bcrypt
import jwt
import datetime
from functools import wraps
from typing import Optional

import uvicorn
import aiofiles
from fastapi import FastAPI, Request, HTTPException, Depends, Form, File, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
import socketio
from werkzeug.utils import secure_filename

# Add the parent directory to sys.path to resolve imports when running as a script
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from setupDB import add_new_user, get_user, update_profile_image, get_connection
from api.services.eligibility_service import EligibilityService
from api.services.image_service import ImageProcessingService

# --- Configuration ---
SECRET_KEY = 'super_secret_key_change_this_later'
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

# --- FastAPI App Setup ---
app = FastAPI()

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
# Note: we keep these as dicts in memory as before, though for production 
# shared state between processes would need Redis/DB.
connected_users = {} # {sid: {"name": username, "family_id": family_id}}

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

# --- Web Routes ---

@app.get("/", response_class=HTMLResponse)
async def homepage(request: Request):
    return templates.TemplateResponse(request, "index.html", {"logged_in_user": request.cookies.get("logged_in_user")})

@app.get("/api/ping")
async def ping():
    return {"status": "successful", "service": "mobile-call-server-fastapi"}

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
    # Default values for simplified registration
    is_successful = await loop.run_in_executor(None, add_new_user, uName, passW, None, 'basic', 1, 'standard', None)

    if is_successful:
        token = generate_token(uName)
        response = JSONResponse({
            "status": "successful", 
            "message": f"Registration successful for {uName}",
            "token": token
        })
        response.set_cookie(key="token", value=token, httponly=False)
        response.set_cookie(key="logged_in_user", value=uName, httponly=False)
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
        response.set_cookie(key="token", value=token, httponly=False)
        response.set_cookie(key="logged_in_user", value=uName, httponly=False)
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
        cursor.execute('SELECT google_photos_album_url, idle_timeout FROM families WHERE id = ?', (family_id,))
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
    
    if current_user['role'] != 'admin' and current_user['role'] != 'caregiver':
        return JSONResponse({"status": "unsuccessful", "message": "Only admin/caregiver can update settings"}, status_code=403)

    family_id = current_user['family_id']
    loop = asyncio.get_event_loop()
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
    admin_role = data.get('role', 'admin') # Default to admin if not provided
    
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
            conn.commit()
            return family_id
        finally:
            conn.close()

    try:
        family_id = await loop.run_in_executor(None, _create)
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
        cursor.execute('SELECT id, username, role, profile_image FROM users WHERE family_id = ?', (family_id,))
        rows = cursor.fetchall()
        members = [{"id": r[0], "username": r[1], "role": r[2], "profile_image": r[3]} for r in rows]
        conn.close()
        return members

    members = await loop.run_in_executor(None, _get)
    return {"status": "successful", "members": members}

@app.post("/api/family/invite")
async def invite_member(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    target_username = data.get('username')
    
    if not current_user['family_id']:
        return JSONResponse({"status": "unsuccessful", "message": "You must create a family before inviting members"}, status_code=400)

    if not target_username:
        return JSONResponse({"status": "unsuccessful", "message": "Username required"}, status_code=400)

    loop = asyncio.get_event_loop()
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

@app.post("/api/notifications/respond")
async def respond_notification(request: Request, current_user = Depends(get_current_user)):
    data = await request.json()
    invite_id = data.get('invite_id')
    response = data.get('response')

    if response not in ['accepted', 'rejected']:
        return JSONResponse({"status": "unsuccessful", "message": "Invalid response"}, status_code=400)

    loop = asyncio.get_event_loop()
    def _respond():
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute('SELECT family_id FROM invitations WHERE id = ? AND receiver_id = ?', (invite_id, current_user['id']))
            invite = cursor.fetchone()
            if not invite: return False
            family_id = invite[0]
            cursor.execute('UPDATE invitations SET status = ? WHERE id = ?', (response, invite_id))
            if response == 'accepted':
                cursor.execute('UPDATE users SET family_id = ? WHERE id = ?', (family_id, current_user['id']))
            conn.commit()
            return True
        finally:
            conn.close()

    success = await loop.run_in_executor(None, _respond)
    if success: return {"status": "successful", "message": f"Invitation {response}"}
    return JSONResponse({"status": "unsuccessful", "message": "Invitation not found"}, status_code=404)

# --- Profile and Image API ---

@app.get("/api/profile")
async def get_profile(current_user = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    def _is_admin():
        if not current_user['family_id']: return False
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT admin_id FROM families WHERE id = ?', (current_user['family_id'],))
        row = cursor.fetchone()
        conn.close()
        return row[0] == current_user['id'] if row else False
    
    is_admin = await loop.run_in_executor(None, _is_admin)
    user_data = dict(current_user)
    user_data['is_family_admin'] = is_admin
    return {"status": "successful", "user": user_data}

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
async def upload_image(image: UploadFile = File(...), username: str = Form(...)):
    filename = secure_filename(f"{username}_group_{image.filename}")
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
async def finalize_crop(request: Request):
    data = await request.json()
    username = data.get('username')
    image_id = data.get('image_id')
    face = data.get('face')

    if not username or not image_id or not face:
        return JSONResponse({"status": "unsuccessful", "message": "Missing data"}, status_code=400)

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
    logged_user = request.cookies.get("logged_in_user")
    if not logged_user: return RedirectResponse(url="/login")
    loop = asyncio.get_event_loop()
    user_data = await loop.run_in_executor(None, get_user, logged_user)
    if not user_data['family_id']: return RedirectResponse(url="/family/create")
    return templates.TemplateResponse(request, "family_settings.html", {"user": user_data, "logged_in_user": logged_user})

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
        loop = asyncio.get_event_loop()
        user_row = await loop.run_in_executor(None, get_user, username)
        if not user_row or not user_row['family_id']: return

        family_id = user_row['family_id']
        room = f"family_{family_id}"
        await sio.enter_room(sid, room)
        connected_users[sid] = {"name": username, "family_id": family_id}
        
        print(f"[JOIN] {username} joined room {room}")
        
        family_members = [{"id": s, "name": u["name"]} for s, u in connected_users.items() if u["family_id"] == family_id]
        await sio.emit('user-list', family_members, room=room)
    except Exception as e:
        print(f"Join error: {e}")

@sio.on('request-user-list')
async def handle_request_user_list(sid, data):
    user_info = connected_users.get(sid)
    if user_info:
        family_id = user_info['family_id']
        family_members = [{"id": s, "name": u["name"]} for s, u in connected_users.items() if u["family_id"] == family_id]
        await sio.emit('user-list', family_members, to=sid)

@sio.on('offer')
async def handle_offer(sid, data):
    target_to = data.get('to')
    user_info = connected_users.get(sid)
    sender_name = user_info['name'] if user_info else "Unknown"
    
    await sio.emit('offer', {
        'from': sid,
        'fromName': sender_name,
        'offer': data.get('offer'),
        'isVideo': data.get('isVideo')
    }, to=target_to)

@sio.on('answer')
async def handle_answer(sid, data):
    await sio.emit('answer', {'from': sid, 'answer': data.get('answer')}, to=data.get('to'))

@sio.on('ice-candidate')
async def handle_ice_candidate(sid, data):
    await sio.emit('ice-candidate', {'from': sid, 'candidate': data.get('candidate')}, to=data.get('to'))

@sio.on('call-rejected')
async def handle_call_rejected(sid, data):
    await sio.emit('call-rejected', {'from': sid}, to=data.get('to'))

@sio.on('end-call')
async def handle_end_call(sid, data):
    await sio.emit('end-call', {'from': sid}, to=data.get('to'))

@sio.on('disconnect')
async def handle_disconnect(sid):
    user_info = connected_users.pop(sid, None)
    if user_info:
        family_id = user_info['family_id']
        room = f"family_{family_id}"
        family_members = [{"id": s, "name": u["name"]} for s, u in connected_users.items() if u["family_id"] == family_id]
        await sio.emit('user-list', family_members, room=room)

# Mount static files after all routes are defined
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")

# Socket.IO ASGI App wrapper
sio_asgi_app = socketio.ASGIApp(sio, app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.app:sio_asgi_app", host="0.0.0.0", port=3000, reload=False)

