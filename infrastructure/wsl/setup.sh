#!/usr/bin/env bash
#
# Provisions PostgreSQL 16 and Redis 7 inside WSL2 Ubuntu.
#
# The portable path is infrastructure/docker/docker-compose.yml. This script is
# the equivalent for a Windows machine without Docker Desktop: WSL2 forwards
# listening ports to Windows 127.0.0.1, so the API running on Windows reaches
# these services with no extra configuration.
#
# Run from inside WSL:
#   bash /mnt/d/restaurant_project/infrastructure/wsl/setup.sh
#
# Idempotent: safe to re-run.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_VERSION=16
OWNER_PASSWORD="${POSTGRES_OWNER_PASSWORD:-owner_password}"

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq "postgresql-${PG_VERSION}" redis-server >/dev/null

echo "==> Starting services"
service postgresql start >/dev/null 2>&1 || true
service redis-server start >/dev/null 2>&1 || true
sleep 3

echo "==> Creating the owner role and database"
# The owner runs migrations and owns every table. The application connects as a
# different, least-privilege role so that Row-Level Security actually applies to
# it (owners are exempt). See docs/LOCAL_SETUP.md.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_owner') THEN
    CREATE ROLE restaurant_owner LOGIN PASSWORD '${OWNER_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'restaurant_os'" | grep -q 1; then
  sudo -u postgres createdb -O restaurant_owner restaurant_os
fi

echo "==> Creating the least-privilege application role"
sudo -u postgres psql -d restaurant_os -v ON_ERROR_STOP=1 -q \
  -f "${REPO_ROOT}/infrastructure/docker/init/01-app-role.sql"

echo "==> Allowing password connections from Windows"
PG_CONF="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"
PG_HBA="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"

if ! grep -qE "^listen_addresses\s*=\s*'\*'" "$PG_CONF"; then
  sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" "$PG_CONF"
fi

if ! grep -q "restaurant_os_local" "$PG_HBA"; then
  {
    echo ""
    echo "# restaurant_os_local — added by infrastructure/wsl/setup.sh"
    echo "host    all    all    127.0.0.1/32    scram-sha-256"
    echo "host    all    all    ::1/128         scram-sha-256"
  } >> "$PG_HBA"
fi

echo "==> Creating the background worker role"
sudo -u postgres psql -d restaurant_os -v ON_ERROR_STOP=1 -q \
  -f "${REPO_ROOT}/infrastructure/docker/init/02-worker-role.sql"

echo "==> Allowing Redis connections from Windows"
# Redis ships bound to 127.0.0.1, which is unreachable from Windows when WSL
# localhost forwarding is off. The WSL virtual switch is not routable from the
# LAN, so this stays a host-only interface — but never mirror this setting on a
# real server, where it would expose Redis to the network.
REDIS_CONF="/etc/redis/redis.conf"
if [ -f "$REDIS_CONF" ]; then
  sed -i 's/^bind 127.0.0.1 -::1/bind 0.0.0.0/' "$REDIS_CONF"
  sed -i 's/^protected-mode yes/protected-mode no/' "$REDIS_CONF"
fi

echo "==> Enabling services at boot"
# systemd is available in this distribution, so the services come back after a
# `wsl --shutdown` without re-running this script.
systemctl enable postgresql >/dev/null 2>&1 || true
systemctl enable redis-server >/dev/null 2>&1 || true

service postgresql restart >/dev/null 2>&1
service redis-server restart >/dev/null 2>&1
sleep 3

echo "==> Verifying"
sudo -u postgres psql -tAc "SELECT version();" | head -1
redis-cli ping
PGPASSWORD=app_password psql -h 127.0.0.1 -U restaurant_app -d restaurant_os \
  -tAc "SELECT 'app role connects as ' || current_user;"

echo ""
echo "Ready. PostgreSQL on 5432, Redis on 6379."
