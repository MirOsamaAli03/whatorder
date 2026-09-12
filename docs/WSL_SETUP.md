# PostgreSQL and Redis on WSL2

For Windows machines without Docker Desktop. WSL2 forwards listening ports to
Windows `127.0.0.1`, so the API running on Windows connects to services inside
Ubuntu with no extra configuration.

Everything below runs **inside WSL**:

```bash
wsl
```

## Install

```bash
sudo apt-get update
sudo apt-get install -y postgresql-16 redis-server
```

Ubuntu 24.04 ships PostgreSQL 16 in its default repositories, which is the
version the project targets.

## Start

WSL has no systemd by default, so start the services directly:

```bash
sudo service postgresql start
sudo service redis-server start
```

Add both to `~/.bashrc` if you would rather not repeat this after each restart.

## Create the roles and database

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE restaurant_owner LOGIN PASSWORD 'owner_password';
CREATE DATABASE restaurant_os OWNER restaurant_owner;
SQL

sudo -u postgres psql -d restaurant_os -v ON_ERROR_STOP=1 \
  -f /mnt/d/restaurant_project/infrastructure/docker/init/01-app-role.sql
```

The second command creates `restaurant_app`, the least-privilege role the API
runs as. It is not a superuser, does not own any table and does not have
`BYPASSRLS`, which is what makes Row-Level Security a real second line of
defence rather than a decoration. See `docs/LOCAL_SETUP.md`.

## Allow password connections from Windows

```bash
sudo sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" \
  /etc/postgresql/16/main/postgresql.conf

echo "host all all 127.0.0.1/32 scram-sha-256" | \
  sudo tee -a /etc/postgresql/16/main/pg_hba.conf

sudo service postgresql restart
```

## Verify from Windows

```powershell
Test-NetConnection 127.0.0.1 -Port 5432
Test-NetConnection 127.0.0.1 -Port 6379
```

Both should report `TcpTestSucceeded : True`. If not, confirm the services are
running inside WSL with `sudo service postgresql status`.
