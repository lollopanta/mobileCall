import sqlite3
import bcrypt
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

# Absolute path anchored to this file — always server/userDatabase.db
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'userDatabase.db')

#establishes a connection to the database
def get_connection():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def ensure_column(cursor, table_name, column_name, definition):
    cursor.execute(f"PRAGMA table_info({table_name})")
    columns = {row[1] for row in cursor.fetchall()}
    if column_name not in columns:
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            admin_id INTEGER,
            primary_grandparent_id INTEGER,
            google_photos_album_url TEXT,
            idle_timeout INTEGER DEFAULT 5,
            FOREIGN KEY (admin_id) REFERENCES users (id),
            FOREIGN KEY (primary_grandparent_id) REFERENCES users (id)
        )
    ''')

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'grandparent',
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

    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS fall_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            family_id INTEGER NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'detected',
            FOREIGN KEY (user_id) REFERENCES users (id),
            FOREIGN KEY (family_id) REFERENCES families (id)
        )
    ''')

    ensure_column(cursor, "families", "primary_grandparent_id", "INTEGER")

    conn.commit()

    # Create default family and grandparent if they don't exist
    cursor.execute('SELECT id FROM families WHERE id = 1')
    if not cursor.fetchone():
        print("Creating default family...")
        cursor.execute('INSERT INTO families (id, name) VALUES (1, "Default Family")')
    
    cursor.execute('SELECT id FROM users WHERE username = "grandparent"')
    if not cursor.fetchone():
        print("Creating default grandparent user...")
        salt = bcrypt.gensalt()
        default_password = os.getenv("DEFAULT_GRANDPARENT_PASSWORD", "change-me-now")
        hashed_password = bcrypt.hashpw(default_password.encode('utf-8'), salt)
        cursor.execute('''
            INSERT INTO users (username, password, role, family_id, is_voip_eligible) 
            VALUES (?, ?, ?, ?, ?)
        ''', ("grandparent", hashed_password, "grandparent", 1, 1))
        
        # Set grandparent as admin of the default family
        cursor.execute('UPDATE families SET admin_id = (SELECT id FROM users WHERE username = "grandparent") WHERE id = 1')

    conn.commit()
    conn.close()

def add_new_user(username, password, age=None, sub_status=None, is_eligible=1, role='grandparent', family_id=None):
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

def log_fall_event(user_id, family_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO fall_logs (user_id, family_id) VALUES (?, ?)', (user_id, family_id))
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
