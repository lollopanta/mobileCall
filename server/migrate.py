import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from setupDB import get_connection

def migrate():
    conn = get_connection()
    cursor = conn.cursor()

    print("Checking for missing columns in 'users' table...")
    
    # Get current columns
    cursor.execute("PRAGMA table_info(users)")
    columns = [row[1] for row in cursor.fetchall()]
    
    missing_columns = {
        'role': "TEXT DEFAULT 'standard'",
        'family_id': "INTEGER",
        'age': "INTEGER",
        'subscription_status': "TEXT",
        'is_voip_eligible': "BOOLEAN DEFAULT 1"
    }

    for col, definition in missing_columns.items():
        if col not in columns:
            print(f"Adding column '{col}'...")
            try:
                cursor.execute(f"ALTER TABLE users ADD COLUMN {col} {definition}")
            except sqlite3.OperationalError as e:
                print(f"Error adding column {col}: {e}")

    # Get current columns for families
    cursor.execute("PRAGMA table_info(families)")
    families_columns = [row[1] for row in cursor.fetchall()]
    
    missing_families_columns = {
        'google_photos_album_url': "TEXT",
        'idle_timeout': "INTEGER DEFAULT 5"
    }

    for col, definition in missing_families_columns.items():
        if col not in families_columns:
            print(f"Adding column '{col}' to 'families' table...")
            try:
                cursor.execute(f"ALTER TABLE families ADD COLUMN {col} {definition}")
            except Exception as e:
                print(f"Error adding column {col} to families: {e}")

    # Ensure families table exists
    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            admin_id INTEGER,
            google_photos_album_url TEXT,
            idle_timeout INTEGER DEFAULT 5,
            FOREIGN KEY (admin_id) REFERENCES users (id)
        )
    ''')

    # Ensure invitations table exists
    cursor.execute(''' 
        CREATE TABLE IF NOT EXISTS invitations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            status TEXT DEFAULT 'pending', -- 'pending', 'accepted', 'rejected'
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (family_id) REFERENCES families (id),
            FOREIGN KEY (sender_id) REFERENCES users (id),
            FOREIGN KEY (receiver_id) REFERENCES users (id)
        )
    ''')

    conn.commit()
    conn.close()
    print("Migration complete.")

if __name__ == "__main__":
    migrate()
