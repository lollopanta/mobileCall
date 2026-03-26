import os
import sys

# Add the parent directory to sys.path to resolve imports when running as a script
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import sqlite3
import bcrypt

from flask import Flask
from markupsafe import escape
from flask import url_for
from flask import request,jsonify,redirect
from flask import render_template
import jwt
import datetime
from functools import wraps

from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from werkzeug.utils import secure_filename
from flask import session

from setupDB import add_new_user, get_user, update_profile_image, get_connection
from flaskr.services.eligibility_service import EligibilityService
from flaskr.services.image_service import ImageProcessingService

# Note: Eventlet/Gevent monkey patching is disabled to ensure compatibility 
# with Python 3.13 + Windows internals. The server will run in 'threading' mode.

app = Flask(__name__)
app.config['SECRET_KEY'] = 'super_secret_key_change_this_later'
CORS(app)

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization')
        if not token:
            return jsonify({'message': 'Token is missing!'}), 401
        try:
            if token.startswith('Bearer '):
                token = token[7:]
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
            current_user = get_user(data['user'])
            if not current_user:
                return jsonify({'message': 'User not found!'}), 401
            print(f"DEBUG: Token User ID: {current_user['id']} for username {data['user']}")
        except Exception as e:
            return jsonify({'message': 'Token is invalid!', 'error': str(e)}), 401
        return f(current_user, *args, **kwargs)
    return decorated

def generate_token(username):
    payload = {
        'user': username,
        'exp': datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=24)
    }
    return jwt.encode(payload, app.config['SECRET_KEY'], algorithm="HS256")

# Configure upload folder
UPLOAD_FOLDER = os.path.abspath(os.path.join(os.path.dirname(__file__), 'static', 'uploads'))
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Explicitly using async_mode='threading' for compatibility with Python 3.13
# Optimized for Cloudflare Tunneling (Higher ping timeout, allow_upgrades for WebSockets)
socketio = SocketIO(
    app, 
    cors_allowed_origins="*", 
    async_mode='threading', 
    manage_session=False, 
    logger=True, 
    engineio_logger=True,
    ping_timeout=60,
    ping_interval=25,
    allow_upgrades=True
)

users = {} # {socket_id: username}
image_processor = ImageProcessingService()

@app.route("/")
def homepage():
	return render_template("index.html")

@app.route("/api/ping", methods=['GET'])
def ping():
    return jsonify({"status": "successful", "service": "mobile-call-server"})

@app.route("/register", methods = ['GET', 'POST'])
def register():
    if request.method == 'GET':
        return render_template("auth/register.html")

    data = request.get_json()
    if not data:
        return jsonify({"status": "unsuccessful", "message": "Invalid JSON data"}), 400

    uName = data.get('username')
    passW = data.get('password')

    if not uName or not passW:
        return jsonify({"status": "unsuccessful", "message": "Username and password required"}), 400

    # Default values for simplified registration (setup later in profile)
    age = None
    sub_status = 'basic'
    role = 'standard'
    family_id = None
    is_eligible = 1

    is_successful = add_new_user(uName, passW, age, sub_status, is_eligible, role, family_id)

    if is_successful == True:
        session['logged_in_user'] = uName
        token = generate_token(uName)
        return jsonify({
            "status": "successful", 
            "message": f"Registration successful for {uName}",
            "token": token
        })
    else:
        return jsonify({"status": "unsuccessful", "message": f"Registration failed, username {uName} may be taken"}), 400

@app.route('/login', methods = ['GET', 'POST'])
def login():
    if request.method == 'GET':
        return render_template("auth/login.html")

    data = request.get_json()
    if not data:
        return jsonify({"status": "unsuccessful", "message": "Invalid JSON data"}), 400

    uName = data.get('username')
    passW = data.get('password')

    user_row = get_user(uName)

    if user_row is None:
        return jsonify({"status": "unsuccessful", "message": "Login unsuccessful, username not found"}), 404
    
    if bcrypt.checkpw(passW.encode('utf-8'), user_row['password']):
        session['logged_in_user'] = uName
        token = generate_token(uName)
        return jsonify({
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
    else:
        return jsonify({"status": "unsuccessful", "message": "Login unsuccessful, password not correct"}), 401

# --- Family Management Endpoints ---

@app.route("/api/family/create", methods=['POST'])
@token_required
def create_family(current_user):
    data = request.get_json()
    family_name = data.get('name')
    if not family_name:
        return jsonify({"status": "unsuccessful", "message": "Family name required"}), 400

    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('INSERT INTO families (name, admin_id) VALUES (?, ?)', (family_name, current_user['id']))
        family_id = cursor.lastrowid
        cursor.execute('UPDATE users SET family_id = ?, role = ? WHERE id = ?', (family_id, 'admin', current_user['id']))
        conn.commit()
        return jsonify({"status": "successful", "family_id": family_id, "message": f"Family '{family_name}' created"})
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/family/add-member", methods=['POST'])
@token_required
def add_family_member(current_user):
    # Only admin can add members
    if current_user['role'] != 'admin':
        return jsonify({"status": "unsuccessful", "message": "Only admins can add members"}), 403

    data = request.get_json()
    member_username = data.get('username')
    role = data.get('role', 'standard')

    if not member_username:
        return jsonify({"status": "unsuccessful", "message": "Username required"}), 400

    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('UPDATE users SET family_id = ?, role = ? WHERE username = ?', (current_user['family_id'], role, member_username))
        if cursor.rowcount == 0:
            return jsonify({"status": "unsuccessful", "message": "User not found"}), 404
        conn.commit()
        return jsonify({"status": "successful", "message": f"User {member_username} added to family as {role}"})
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/family/members", methods=['GET'])
@token_required
def get_family_members(current_user):
    family_id = current_user['family_id']
    if not family_id:
        return jsonify({"status": "successful", "members": []})

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT id, username, role, profile_image FROM users WHERE family_id = ?', (family_id,))
    rows = cursor.fetchall()
    members = []
    for r in rows:
        members.append({
            "id": r[0],
            "username": r[1],
            "role": r[2],
            "profile_image": r[3]
        })
    conn.close()
    return jsonify({"status": "successful", "members": members})

@app.route("/api/family/invite", methods=['POST'])
@token_required
def invite_member(current_user):
    data = request.get_json()
    target_username = data.get('username')
    
    print(f"DEBUG: FULL current_user in invite_member: {current_user}")
    if not current_user['family_id']:
        return jsonify({"status": "unsuccessful", "message": "You must create a family before inviting members"}), 400

    if not target_username:
        return jsonify({"status": "unsuccessful", "message": "Username required"}), 400

    conn = get_connection()
    cursor = conn.cursor()
    try:
        # 1. Find target user
        cursor.execute('SELECT id, family_id FROM users WHERE username = ?', (target_username,))
        target_user = cursor.fetchone()
        if not target_user:
            return jsonify({"status": "unsuccessful", "message": "User not found"}), 404
        
        target_id, target_family_id = target_user
        if target_family_id:
            return jsonify({"status": "unsuccessful", "message": "User is already in a family"}), 400

        # 2. Check if already invited
        cursor.execute('SELECT id FROM invitations WHERE family_id = ? AND receiver_id = ? AND status = "pending"', 
                       (current_user['family_id'], target_id))
        if cursor.fetchone():
            return jsonify({"status": "unsuccessful", "message": "Invitation already pending"}), 400

        # 3. Create invitation
        cursor.execute('INSERT INTO invitations (family_id, sender_id, receiver_id) VALUES (?, ?, ?)',
                       (current_user['family_id'], current_user['id'], target_id))
        conn.commit()
        return jsonify({"status": "successful", "message": f"Invitation sent to {target_username}"})
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/notifications", methods=['GET'])
@token_required
def get_notifications(current_user):
    conn = get_connection()
    cursor = conn.cursor()
    # Join with families and senders to get names
    print(f"DEBUG: Getting notifications for receiver_id={current_user['id']}")
    cursor.execute('''
        SELECT i.id, f.name, u.username, i.status, i.created_at
        FROM invitations i
        JOIN families f ON i.family_id = f.id
        JOIN users u ON i.sender_id = u.id
        WHERE i.receiver_id = ? AND i.status = "pending"
    ''', (current_user['id'],))
    invites = []
    for row in cursor.fetchall():
        invites.append({
            "id": row[0],
            "family_name": row[1],
            "sender_name": row[2],
            "status": row[3],
            "date": row[4]
        })
    conn.close()
    return jsonify({"status": "successful", "notifications": invites})

@app.route("/api/notifications/respond", methods=['POST'])
@token_required
def respond_notification(current_user):
    data = request.get_json()
    invite_id = data.get('invite_id')
    response = data.get('response') # 'accepted' or 'rejected'

    if response not in ['accepted', 'rejected']:
        return jsonify({"status": "unsuccessful", "message": "Invalid response"}), 400

    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Verify invitation belongs to user
        cursor.execute('SELECT family_id FROM invitations WHERE id = ? AND receiver_id = ?', (invite_id, current_user['id']))
        invite = cursor.fetchone()
        if not invite:
            return jsonify({"status": "unsuccessful", "message": "Invitation not found"}), 404

        family_id = invite[0]
        
        # Update invitation
        cursor.execute('UPDATE invitations SET status = ? WHERE id = ?', (response, invite_id))
        
        if response == 'accepted':
            # Join family
            cursor.execute('UPDATE users SET family_id = ? WHERE id = ?', (family_id, current_user['id']))
            
        conn.commit()
        return jsonify({"status": "successful", "message": f"Invitation {response}"})
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/profile", methods=['GET', 'POST'])
@token_required
def profile_api(current_user):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        if request.method == 'GET':
            cursor.execute('SELECT id, username, role, family_id, is_voip_eligible, age FROM users WHERE id = ?', (current_user['id'],))
            row = cursor.fetchone()
            if row:
                user_data = {
                    "id": row[0],
                    "username": row[1],
                    "role": row[2],
                    "family_id": row[3],
                    "is_voip_eligible": bool(row[4]),
                    "age": row[5]
                }
                return jsonify({"status": "successful", "user": user_data})
            return jsonify({"status": "unsuccessful", "message": "User not found"}), 404
        
        # POST logic
        data = request.get_json()
        role = data.get('role')
        age = data.get('age')

        if role:
            cursor.execute('UPDATE users SET role = ? WHERE id = ?', (role, current_user['id']))
        if age:
            cursor.execute('UPDATE users SET age = ? WHERE id = ?', (age, current_user['id']))
        conn.commit()
        return jsonify({"status": "successful", "message": "Profile updated"})
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500
    finally:
        conn.close()

@app.route("/upload-image", methods=['POST'])
def upload_image():
    if 'image' not in request.files:
        return jsonify({"status": "unsuccessful", "message": "No image part"}), 400
    
    file = request.files['image']
    username = request.form.get('username')
    
    if file.filename == '' or not username:
        return jsonify({"status": "unsuccessful", "message": "No selected file or username"}), 400

    filename = secure_filename(f"{username}_group_{file.filename}")
    temp_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(temp_path)

    try:
        faces, img_shape = image_processor.detect_faces(temp_path)
        return jsonify({
            "status": "successful",
            "message": f"Detected {len(faces)} faces",
            "faces": faces,
            "image_id": filename
        })
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500

@app.route("/finalize-crop", methods=['POST'])
def finalize_crop():
    data = request.get_json()
    username = data.get('username')
    image_id = data.get('image_id')
    face_coords = data.get('face') # {x, y, w, h}

    if not username or not image_id or not face_coords:
        return jsonify({"status": "unsuccessful", "message": "Missing data"}), 400

    input_path = os.path.join(app.config['UPLOAD_FOLDER'], image_id)
    output_filename = f"{username}_profile.jpg"
    output_path = os.path.join(app.config['UPLOAD_FOLDER'], output_filename)

    try:
        image_processor.crop_face(
            input_path, 
            face_coords['x'], 
            face_coords['y'], 
            face_coords['w'], 
            face_coords['h'], 
            output_path
        )
        # Update database
        update_profile_image(username, f"/static/uploads/{output_filename}")
        return jsonify({
            "status": "successful",
            "message": "Profile image updated",
            "profile_image": f"/static/uploads/{output_filename}"
        })
    except Exception as e:
        return jsonify({"status": "unsuccessful", "message": str(e)}), 500

@app.route("/user/<username>")
def profile(username):
    #check if the cookie exists and matches the URL
    if 'logged_in_user' not in session or session['logged_in_user'] != username:
        return redirect(url_for('login')) # Safer than direct text

    user_data = get_user(username)
    return render_template("profile.html", user=user_data)

@app.route("/family/create")
def create_family_view():
    if 'logged_in_user' not in session:
        return redirect(url_for('login'))
    return render_template("create_family.html")

@app.route("/family/settings")
def family_settings_view():
    if 'logged_in_user' not in session:
        return redirect(url_for('login'))
    user_data = get_user(session['logged_in_user'])
    if not user_data['family_id']: # No family_id
        return redirect(url_for('create_family_view'))
    return render_template("family_settings.html", user=user_data)

@app.route("/notifications")
def notifications_view():
    if 'logged_in_user' not in session:
        return redirect(url_for('login'))
    return render_template("notifications.html")

@app.route("/logout")
def logout():
    session.pop('logged_in_user', None)
    return redirect(url_for('homepage'))

@socketio.on('connect')
def handle_connect():
    print(f"[CONNECT] ID: {request.sid} | IP: {request.remote_addr}")

@socketio.on('join')
def handle_join(data):
    # data can be a token or just the family_id if already authenticated
    token = data.get('token')
    if not token:
        print("[JOIN] Failed: No token provided")
        return
    try:
        decoded = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
        username = decoded['user']
        user_row = get_user(username)
        if not user_row:
            print(f"[JOIN] Failed: User {username} not found in DB")
            return
        
        family_id = user_row['family_id']
        if not family_id:
            print(f"[JOIN] Failed: User {username} has no family_id")
            return

        room = f"family_{family_id}"
        join_room(room)
        users[request.sid] = {"name": username, "family_id": family_id}
        
        print(f"[JOIN] {username} (ID: {request.sid}) joined room {room}")
        
        # Emit updated user list to the room
        family_members = [{"id": sid, "name": u["name"]} for sid, u in users.items() if u["family_id"] == family_id]
        emit('user-list', family_members, to=room)
    except Exception as e:
        print(f"Join error: {e}")

@socketio.on('request-user-list')
def handle_request_user_list(data):
    user_info = users.get(request.sid)
    if user_info:
        family_id = user_info['family_id']
        family_members = [{"id": sid, "name": u["name"]} for sid, u in users.items() if u["family_id"] == family_id]
        emit('user-list', family_members)

@socketio.on('offer')
def handle_offer(data):
    target_to = data.get('to')
    user_info = users.get(request.sid)
    sender_name = user_info['name'] if user_info else "Unknown"
    
    print(f"[OFFER] From: {sender_name} ({request.sid}) -> To: {target_to}")
    
    if target_to not in users:
        print(f"[OFFER] Error: Target {target_to} not in active users list")
        print(f"Current connected IDs: {list(users.keys())}")
        return

    emit('offer', {
        'from': request.sid,
        'fromName': sender_name,
        'offer': data.get('offer'),
        'isVideo': data.get('isVideo')
    }, to=target_to)
    print(f"[OFFER] Emitted to {target_to}")

@socketio.on('answer')
def handle_answer(data):
    target_to = data.get('to')
    print(f"[ANSWER] From: {request.sid} -> To: {target_to}")
    emit('answer', {'from': request.sid, 'answer': data.get('answer')}, to=target_to)

@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    target_to = data.get('to')
    # Too many candidates to log all, but log the first few
    # print(f"[ICE] From: {request.sid} -> To: {target_to}")
    emit('ice-candidate', {'from': request.sid, 'candidate': data.get('candidate')}, to=target_to)

@socketio.on('call-rejected')
def handle_call_rejected(data):
    target_to = data.get('to')
    print(f"[REJECTED] From: {request.sid} -> To: {target_to}")
    emit('call-rejected', {'from': request.sid}, to=target_to)

@socketio.on('end-call')
def handle_end_call(data):
    target_to = data.get('to')
    print(f"[END-CALL] From: {request.sid} -> To: {target_to}")
    emit('end-call', {'from': request.sid}, to=target_to)

@socketio.on('disconnect')
def handle_disconnect():
    user_info = users.pop(request.sid, None)
    if user_info:
        username = user_info['name']
        family_id = user_info['family_id']
        room = f"family_{family_id}"
        print(f"[DISCONNECT] ID: {request.sid} ({username})")
        family_members = [{"id": sid, "name": u["name"]} for sid, u in users.items() if u["family_id"] == family_id]
        emit('user-list', family_members, to=room)

if __name__ == "__main__":
    # use_reloader=False is critical — the reloader forks a child process which resets
    # the in-memory users={} dict, making all connected clients invisible to each other.
    socketio.run(app, host='0.0.0.0', port=3000, debug=True, use_reloader=False)