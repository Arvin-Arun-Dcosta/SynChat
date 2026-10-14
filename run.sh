#!/usr/bin/env bash
# Start SynChat locally.
#
#   ./run.sh          database + API + web app in development (http://localhost:5173)
#   ./run.sh seed     load the demo data first, then start as above
#   ./run.sh prod     build, then serve everything from one server (http://localhost:5001)
#   ./run.sh stop     stop the database container
#
# It always uses the local Docker database (the one `npm run seed` fills), whatever
# DATABASE_URL in .env says. Add --env-db to use the database from .env instead:
#   ./run.sh --env-db
set -euo pipefail

cd "$(dirname "$0")"

# Node gives each address of a host 250 ms to answer before trying the next one.
# A database in another region can take longer, so allow two seconds.
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=2000"

die() {
  echo "run.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

LOCAL_DATABASE_URL="postgres://synchat:synchat@127.0.0.1:5433/synchat"
mode="dev"
use_env_db=false
for arg in "$@"; do
  case "$arg" in
    --env-db) use_env_db=true ;;
    *) mode="$arg" ;;
  esac
done
# A value set here wins over .env, which is only read for names that are not set yet.
$use_env_db || export DATABASE_URL="$LOCAL_DATABASE_URL"

check_tools() {
  command -v node >/dev/null || die "Node.js is not installed (version 22 or newer is needed)."
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Node.js 22 or newer is needed; this is $(node -v)."
  command -v docker >/dev/null || die "Docker is not installed."
  docker info >/dev/null 2>&1 || die "Docker is not running. Start it and try again."
}

prepare() {
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
  fi
  if [ ! -d node_modules ] || [ ! -d backend/node_modules ] || [ ! -d frontend/node_modules ]; then
    echo "Installing dependencies..."
    npm run setup
  fi
  echo "Starting the database..."
  npm run db:up
  if $use_env_db; then
    echo "Using the database from .env."
  else
    echo "Using the local Docker database."
  fi
}

case "$mode" in
  dev)
    check_tools
    prepare
    echo "Open http://localhost:5173 (Ctrl+C to stop)"
    exec npm run dev
    ;;
  seed)
    check_tools
    prepare
    npm run seed
    echo "Open http://localhost:5173 (Ctrl+C to stop)"
    exec npm run dev
    ;;
  prod)
    check_tools
    prepare
    npm run build
    port=${PORT:-5001}
    echo "Open http://localhost:$port (Ctrl+C to stop)"
    NODE_ENV=production PORT=$port CLIENT_ORIGIN="http://localhost:$port" exec npm start
    ;;
  stop)
    exec npm run db:down
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
