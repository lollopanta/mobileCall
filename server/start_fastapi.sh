#!/bin/bash
echo "🚀 Starting the MobileCall Signaling Server (FastAPI + asyncio)..."

# Ensure we use the virtual environment
source .venv/bin/activate
python api/app.py