import sqlite3
import bcrypt
import os

# Absolute path anchored to this file — always server/userDatabase.db
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'userDatabase.db')

#establishes a connection to the database
def get_connection():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            admin_id INTEGER,
            FOREIGN KEY (admin_id) REFERENCES users (id)
        )
    ''')

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'standard',
            family_id INTEGER,
            age INTEGER,
            subscription_status TEXT,
            is_voip_eligible BOOLEAN DEFAULT 1,
            profile_image TEXT,
            FOREIGN KEY (family_id) REFERENCES families (id)
        )
    ''')

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS invitations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families (id),
            FOREIGN KEY (sender_id) REFERENCES users (id),
            FOREIGN KEY (receiver_id) REFERENCES users (id)
        )
    ''')

    conn.commit()
    conn.close()

def add_new_user(username, password, age=None, sub_status=None, is_eligible=1, role='standard', family_id=None):
    conn = get_connection()
    cursor = conn.cursor()

    try:
        salt = bcrypt.gensalt()
        hashed_password = bcrypt.hashpw(password.encode('utf-8'), salt)
        cursor.execute('''
            INSERT INTO users (username, password, age, subscription_status, is_voip_eligible, role, family_id) 
            VALUES (?,?,?,?,?,?,?)
        ''', (username, hashed_password, age, sub_status, is_eligible, role, family_id))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

def get_user(username):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM users WHERE username = ?', (username,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return None

def update_profile_image(username, image_path):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('UPDATE users SET profile_image = ? WHERE username = ?', (image_path, username))
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
