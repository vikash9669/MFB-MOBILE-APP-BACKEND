#!/usr/bin/env bash
# Clone a database into a dev replica, so nothing in development ever points at
# the production clone.
#
# Usage:
#   ./scripts/clone-db-to-dev.sh                      # mfb_app     -> mfb_app_dev
#   ./scripts/clone-db-to-dev.sh mfb_legacy           # mfb_legacy  -> mfb_legacy_dev
#   ./scripts/clone-db-to-dev.sh mfb_app my_sandbox   # explicit source and target
#
# Safety properties:
#   • The SOURCE is only ever read (mysqldump --single-transaction, no locks
#     held, no writes). Nothing this script does can alter it.
#   • The TARGET is dropped and recreated on every run, so re-running gives a
#     fresh replica. It refuses to run if the target name matches the source.
#   • A dedicated MySQL user is created with privileges ONLY on the target, so a
#     misconfigured app physically cannot reach the production clone.
#
# Needs a MySQL account that can CREATE DATABASE and GRANT (normally root). It
# is prompted for, never stored.
set -euo pipefail

SRC_DB="${1:-mfb_app}"
DEV_DB="${2:-${SRC_DB}_dev}"

HOST="${DB_HOST_OVERRIDE:-127.0.0.1}"
PORT="${DB_PORT_OVERRIDE:-33061}"

DEV_USER="${DEV_DB_USER:-mfb_dev}"
DEV_PASS="${DEV_DB_PASSWORD:-mfb_dev_password}"

if [ "$SRC_DB" = "$DEV_DB" ]; then
  echo "Refusing to clone '$SRC_DB' onto itself." >&2
  exit 1
fi

# The target gets DROPPED, so it must be unmistakably a dev database. Without
# this, a slip like `clone-db-to-dev.sh mfb_app mfb_legacy` would destroy a
# production database in one keystroke.
case "$DEV_DB" in
  *_dev) ;;
  *)
    if [ "${ALLOW_UNSAFE_TARGET:-}" != "1" ]; then
      echo "Refusing to drop '$DEV_DB': target names must end in '_dev'." >&2
      echo "Set ALLOW_UNSAFE_TARGET=1 only if you are certain." >&2
      exit 1
    fi
    echo "WARNING: dropping non-_dev database '$DEV_DB' (ALLOW_UNSAFE_TARGET=1)." >&2
    ;;
esac

DUMP="$(mktemp -t "${SRC_DB}.XXXXXX.sql")"
# The dump is a full copy of production data — never leave it lying around.
trap 'rm -f "$DUMP"' EXIT

echo "Source : $SRC_DB   (read-only)"
echo "Target : $DEV_DB   (will be DROPPED and recreated)"
echo "Server : $HOST:$PORT"
echo
# Credentials come from the environment when set (repeatable runs, CI, testing
# against a throwaway server), otherwise they're prompted for and never stored.
if [ -n "${MYSQL_ADMIN_PASSWORD:-}" ]; then
  ADMIN_USER="${MYSQL_ADMIN_USER:-root}"
  ADMIN_PASS="$MYSQL_ADMIN_PASSWORD"
  echo "Using MYSQL_ADMIN_USER=$ADMIN_USER from the environment."
else
  read -r -p "MySQL admin user [root]: " ADMIN_USER
  # Guards against pasted text being swallowed as input: anything with a space
  # or a '#' is a stray line, not a username.
  case "$ADMIN_USER" in
    *[[:space:]]*|\#*) echo "Ignoring stray input '$ADMIN_USER' — using root." >&2; ADMIN_USER=root ;;
  esac
  ADMIN_USER="${ADMIN_USER:-root}"
  read -r -s -p "Password for $ADMIN_USER: " ADMIN_PASS
  echo
  if [ -z "$ADMIN_PASS" ]; then
    echo "No password entered. If you pasted a multi-line block, the extra lines" >&2
    echo "were consumed by these prompts — paste only the command, then type." >&2
    exit 1
  fi
fi
echo

# Password goes through MYSQL_PWD, not the command line: an argv password is
# visible to every user on the box via `ps aux` for as long as the client runs,
# and the client warns about it on every invocation.
export MYSQL_PWD="$ADMIN_PASS"
MY=(-h "$HOST" -P "$PORT" -u "$ADMIN_USER" --protocol=TCP)

echo "==> Checking credentials"
if ! mysql "${MY[@]}" -N -e "SELECT 1" >/dev/null 2>&1; then
  cat >&2 <<ERR
Could not connect to $HOST:$PORT as '$ADMIN_USER'.

This needs an account that can CREATE DATABASE and GRANT — normally 'root'.
The backend's own user (mfb_admin) has USAGE only and cannot do either.
The root password is the MYSQL_ROOT_PASSWORD set in the admin panel's
docker-compose.yml.
ERR
  exit 1
fi

echo "==> Verifying source exists"
mysql "${MY[@]}" -N -e "SHOW DATABASES LIKE '$SRC_DB'" | grep -qx "$SRC_DB" \
  || { echo "Connected fine, but database '$SRC_DB' does not exist on this server." >&2; exit 1; }

echo "==> Dumping $SRC_DB (no writes, no table locks)"
mysqldump "${MY[@]}" \
  --single-transaction --quick --routines --triggers --events \
  --set-gtid-purged=OFF \
  "$SRC_DB" > "$DUMP"
echo "    dump size: $(du -h "$DUMP" | cut -f1)"

echo "==> Recreating $DEV_DB"
mysql "${MY[@]}" -e "DROP DATABASE IF EXISTS \`$DEV_DB\`;
                     CREATE DATABASE \`$DEV_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "==> Importing"
mysql "${MY[@]}" "$DEV_DB" < "$DUMP"

echo "==> Creating restricted dev user '$DEV_USER' (access to $DEV_DB only)"
# Grants accumulate deliberately: cloning mfb_admin must not revoke the access
# granted when mfb_app was cloned. Every grant this script issues is on a target
# that passed the '_dev' check above, so the user still cannot reach production.
mysql "${MY[@]}" -e "
  CREATE USER IF NOT EXISTS '$DEV_USER'@'%' IDENTIFIED BY '$DEV_PASS';
  ALTER USER '$DEV_USER'@'%' IDENTIFIED BY '$DEV_PASS';
  GRANT ALL PRIVILEGES ON \`$DEV_DB\`.* TO '$DEV_USER'@'%';
  FLUSH PRIVILEGES;"

echo
echo "==> Verifying replica matches source"
SRC_N=$(mysql "${MY[@]}" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$SRC_DB'")
DEV_N=$(mysql "${MY[@]}" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DEV_DB'")
echo "    tables: source=$SRC_N  replica=$DEV_N"
[ "$SRC_N" = "$DEV_N" ] || { echo "    MISMATCH — investigate before using this replica." >&2; exit 1; }

echo
echo "Done. '$DEV_DB' is a fresh replica of '$SRC_DB'."
echo
echo "Credentials for the replica:  user=$DEV_USER  password=$DEV_PASS"
echo

# Which consumer to point at this replica depends on which database was cloned,
# so only print the advice that actually applies.
case "$SRC_DB" in
  mfb_app)
    cat <<EOF
This is the backend's database. Edit MFB-MOBILE-APP-BACKEND/.env:

    DB_NAME=$DEV_DB
    DB_USER_NAME=$DEV_USER
    DB_PASSWORD=$DEV_PASS

then restart it. nodemon does not watch .env, so a running server keeps the old
values until you stop and start it.

The customer and delivery apps need no change — they reach the database only
through the backend.
EOF
    ;;
  mfb_admin|mfb_legacy)
    cat <<EOF
This is a PHP admin panel database, not the backend's. Point the panel at it:

  • :8090 admin  — credentials are hardcoded; update 'database', 'username' and
                   'password' in the application/config/database.php files and
                   in config.php.
  • :8091 legacy — reads DB_NAME / DB_USER / DB_PASSWORD from the environment;
                   change them in docker-compose.yml, then restart that container.

Do NOT point MFB-MOBILE-APP-BACKEND/.env at this database.
EOF
    ;;
esac

echo
echo "Re-run this script whenever you want to refresh the replica from production."
