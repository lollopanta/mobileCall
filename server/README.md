# MobileCall Signaling Server

A high-performance WebRTC signaling server built with Flask and Socket.IO. This server manages user authentication, persistent presence, and real-time signaling for video calls between mobile and web clients.

---

## 🚀 Features

*   **Real-time Signaling**: WebRTC handshake management (Offer/Answer/ICE) via Socket.IO.
*   **Persistent Presence**: Automatic user list updates and connection tracking.
*   **Secure Authentication**: User registration and login with bcrypt password hashing.
*   **Database Integration**: Lightweight SQLite storage for user profiles and credentials.
*   **Premium Web Interface**: Modern, dark-mode web dashboard for profile management and call monitoring.

---

## 🛠 Prerequisites

Ensure you have the following installed:

*   **Python 3.12+** (Developed and tested on 3.13)
*   **pip** (Python package manager)
*   **Google Chrome** (Recommended for web client)

---

## 📥 Installation

1.  **Clone the Repository**
    ```bash
    git clone <repository-url>
    cd MobileCall/server
    ```

2.  **Set up Virtual Environment**
    ```bash
    # Windows
    python -m venv .venv
    .venv\Scripts\activate

    # Linux/MacOS
    python3 -m venv .venv
    source .venv/bin/activate
    ```

3.  **Install Dependencies**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Initialize Database**
    ```bash
    python setupDB.py
    ```

---

## 🏃 Running the Server

To start the signaling server with WebSocket support, run:

```bash
# Windows & Linux
python fastapi/app.py
```

> [!IMPORTANT]
> **Do not use `flask run`**. Standard Flask development servers do not support the persistent WebSocket upgrades required for WebRTC. Always use `python fastapi/app.py`.

The server will be available at:
-   **Local**: `http://127.0.0.1:3000`
-   **Network**: `http://<your-ip>:3000`

---

## 📱 Mobile Integration

For mobile clients connecting to this server:
*   Ensure the `socket.io-client` version matches the server requirements.
*   The server listens on **Port 3000**.
*   The signaling path is default (`/socket.io/`).
*   **Transport restriction**: Use `transports: ['websocket']` for maximum stability.

---

## 🎨 Web Dashboard

The web interface is built with:
*   **Flask Templates**: Semantic HTML5.
*   **Custom CSS**: Modern dark-mode aesthetics with Glassmorphism.
*   **Socket.IO Client**: Integrated signaling logic.

Access the dashboard by navigating to `http://localhost:3000` in your browser.

---

## ⚖️ License
This project is licensed under the MIT License - see the LICENSE file for details.
