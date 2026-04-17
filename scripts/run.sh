#!/usr/bin/env bash
# Launch the cockpit locally.
set -e
cd "$(dirname "$0")/.."

if [ ! -d ".venv" ]; then
  echo "→ creating virtualenv in .venv"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "→ installing dependencies"
pip install -q -r requirements.txt

echo "→ starting uvicorn on http://127.0.0.1:8000"
exec uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
