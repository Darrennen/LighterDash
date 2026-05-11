#!/bin/bash
# Run on the VPS to pull latest code and restart the service
set -e
APP_DIR="/opt/lighter-cockpit"
SERVICE="lighter-cockpit"

echo "==> Pulling latest code…"
cd "$APP_DIR"
git pull

echo "==> Installing any new dependencies…"
.venv/bin/pip install -q -r requirements.txt

echo "==> Restarting service…"
systemctl restart "$SERVICE"
systemctl status "$SERVICE" --no-pager
echo "✓ Updated."
