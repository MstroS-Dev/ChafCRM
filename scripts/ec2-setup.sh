#!/usr/bin/env bash
# One-time setup of ChafCRM on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu).
# Usage (on the server):
#   curl -fsSL https://raw.githubusercontent.com/MstroS-Dev/ChafCRM/main/scripts/ec2-setup.sh | bash
# or, after cloning:  bash scripts/ec2-setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MstroS-Dev/ChafCRM.git}"
APP_DIR="${APP_DIR:-$HOME/ChafCRM}"

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

# ── 1. Docker + git
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker and git"
  if [ -f /etc/os-release ] && grep -qi 'amazon' /etc/os-release; then
    sudo dnf install -y docker git
    sudo systemctl enable --now docker
    # Docker Compose v2 plugin (not packaged on Amazon Linux)
    ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] || ARCH=x86_64
    sudo mkdir -p /usr/local/lib/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  else
    sudo apt-get update -y && sudo apt-get install -y git curl
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# ── 2. Code
if [ ! -d "$APP_DIR/.git" ]; then
  log "Cloning $REPO_URL into $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ── 3. .env with generated secrets
if [ ! -f .env ]; then
  log "Creating .env"
  cp .env.example .env
  TOKEN=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  PUBLIC_IP=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  ADMIN_PW=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 14)
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^WEBHOOK_KEY=.*|WEBHOOK_KEY=$(openssl rand -hex 16)|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PW}|" .env
  [ -n "$PUBLIC_IP" ] && sed -i "s|^BASE_URL=.*|BASE_URL=http://${PUBLIC_IP}:3000|" .env
  echo
  echo "  Manager login:  admin / ${ADMIN_PW}"
  echo "  (saved in $APP_DIR/.env — edit that file to change settings)"
fi
mkdir -p data

# ── 4. Run
log "Building and starting"
if grep -qE '^DOMAIN=.+' .env; then
  $DOCKER compose --profile https up -d --build
else
  $DOCKER compose up -d --build
fi

log "Done"
grep -E '^BASE_URL=' .env | sed 's/BASE_URL=/  Open: /'
echo "  Make sure the EC2 security group allows inbound TCP 3000 (or 80/443 when using a domain)."
