#!/bin/bash
# Replaces the development passwords on the two least-privilege roles.
#
# 01-app-role.sql and 02-worker-role.sql create `restaurant_app` and
# `restaurant_worker` with the well-known development passwords, which is right
# for a local machine and completely wrong anywhere else: they are committed to
# the repository, so a deployment that kept them would be publishing its own
# database credentials.
#
# This runs after both (the entrypoint sorts by filename) and rewrites the
# passwords from the environment. It is a no-op when the variables are unset, so
# the local setup is unchanged.
#
# NOTE: Postgres runs these scripts only when the data directory is first
# initialised. Rotating a password on an existing deployment means running the
# ALTER ROLE yourself — see docs/DEPLOYMENT.md.
set -euo pipefail

if [ -z "${APP_PASSWORD:-}" ] && [ -z "${WORKER_PASSWORD:-}" ]; then
  echo "No APP_PASSWORD or WORKER_PASSWORD set; leaving development passwords in place."
  exit 0
fi

# psql's :'variable' interpolation quotes and escapes the value, so a password
# containing a quote cannot break out into the statement.
if [ -n "${APP_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v pw="$APP_PASSWORD" <<-'SQL'
		ALTER ROLE restaurant_app PASSWORD :'pw';
	SQL
  echo "Set the restaurant_app password from the environment."
fi

if [ -n "${WORKER_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v pw="$WORKER_PASSWORD" <<-'SQL'
		ALTER ROLE restaurant_worker PASSWORD :'pw';
	SQL
  echo "Set the restaurant_worker password from the environment."
fi
