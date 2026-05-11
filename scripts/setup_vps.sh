#!/bin/bash
# Lighter Cockpit — VPS setup script
# Run as root on a fresh Ubuntu 22.04 / 24.04 server:
#   curl -sL https://raw.githubusercontent.com/Darrennen/LighterDash/main/scripts/setup_vps.sh | bash

set -e

REPO="https://github.com/Darrennen/LighterDash.git"
APP_DIR="/opt/lighter-cockpit"
SERVICE="lighter-cockpit"
PORT=8000

echo "==> Installing system packages…"
apt-get update -qq
apt-get install -y python3 python3-pip python3-venv git nginx ufw

echo "==> Cloning repo to $APP_DIR…"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO" "$APP_DIR"
fi

echo "==> Creating Python virtual environment…"
cd "$APP_DIR"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

echo "==> Creating data directory…"
mkdir -p "$APP_DIR/data"

echo "==> Writing systemd service…"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Lighter Cockpit
After=network.target

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${PORT}
Restart=always
RestartSec=5
Environment=DB_PATH=${APP_DIR}/data/cockpit.db

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling and starting service…"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo "==> Configuring nginx…"
cat > /etc/nginx/sites-available/lighter-cockpit <<EOF
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/lighter-cockpit /etc/nginx/sites-enabled/lighter-cockpit
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Configuring firewall…"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "✓ Done! Lighter Cockpit is running at http://$(curl -s ifconfig.me)"
echo ""
echo "Useful commands:"
echo "  systemctl status $SERVICE       # check if running"
echo "  journalctl -u $SERVICE -f       # live logs"
echo "  systemctl restart $SERVICE      # restart after code update"
