#!/usr/bin/env bash
# 本地开发模式（无 Docker）：PostgreSQL(用户级, 端口55432) + Redis + mock + api + worker + web
# 用法: bash scripts/dev-up.sh   （停止: bash scripts/dev-down.sh）
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p logs .pids data

PG_BIN=${PG_BIN:-/usr/lib/postgresql/15/bin}
export PGPORT=${PGPORT:-55432}
export PGSOCK=${PGSOCK:-/tmp/pgsock}

# 1) PostgreSQL（用户级实例；如系统已有 5432 的实例，可设 PGPORT=5432 PGSOCK=/var/run/postgresql）
if ! "$PG_BIN/pg_isready" -h "$PGSOCK" -p "$PGPORT" -U collector >/dev/null 2>&1; then
  mkdir -p "$PGSOCK"
  if [ ! -d "$ROOT/.pgdata/base" ]; then
    "$PG_BIN/initdb" -D "$ROOT/.pgdata" -U collector --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    echo "unix_socket_directories = '$PGSOCK'" >> "$ROOT/.pgdata/postgresql.conf"
    echo "port = $PGPORT" >> "$ROOT/.pgdata/postgresql.conf"
  fi
  "$PG_BIN/pg_ctl" -D "$ROOT/.pgdata" -l logs/pg.log start >/dev/null
  sleep 1
  "$PG_BIN/psql" -h "$PGSOCK" -U collector -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='collector'" | grep -q 1 \
    || "$PG_BIN/psql" -h "$PGSOCK" -U collector -d postgres -c "CREATE DATABASE collector" >/dev/null
fi
"$PG_BIN/psql" -h "$PGSOCK" -U collector -d collector -q -f db/01_schema.sql
"$PG_BIN/psql" -h "$PGSOCK" -U collector -d collector -q -f db/02_seed.sql

# 2) Redis
redis-cli ping >/dev/null 2>&1 || (redis-server --daemonize yes --logfile "$ROOT/logs/redis.log" && sleep 1)

# 3) 构建
[ -d api/dist ] || (cd api && npm run build)
[ -d worker/dist ] || (cd worker && npm run build)

# 4) 应用环境
export PGHOST="$PGSOCK" PGUSER=collector PGPASSWORD=collector PGDATABASE=collector
export REDIS_HOST=localhost MOCK_BASE_URL=http://localhost:4500 DATA_DIR="$ROOT/data"
# 无 root 环境下为 Chromium 准备的本地系统库（如有）
[ -d "$ROOT/.syslibs/usr/lib/x86_64-linux-gnu" ] && export LD_LIBRARY_PATH="$ROOT/.syslibs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

start() { # name dir cmd...
  local name=$1 dir=$2; shift 2
  if [ -f ".pids/$name" ] && kill -0 "$(cat .pids/$name)" 2>/dev/null; then echo "[$name] 已在运行"; return; fi
  ( cd "$dir" || exit 1
    nohup "$@" </dev/null >"$ROOT/logs/$name.log" 2>&1 &
    echo $! >"$ROOT/.pids/$name" )
  echo "[$name] 已启动 pid=$(cat .pids/$name)"
}

start mock   mock-platform node server.js
start api    api           node dist/main.js
start worker worker        node dist/main.js
if [ "${NO_WEB:-0}" != "1" ]; then
  start web web npx vite --host 0.0.0.0 --port 5173
fi

sleep 2
echo "--- 健康检查 ---"
curl -s --max-time 3 http://localhost:4500/healthz && echo "  mock :4500"
curl -s --max-time 3 http://localhost:8080/api/health && echo "  api  :8080"
echo "web  :5173 (vite dev, 首次访问需编译)"
echo "日志: $ROOT/logs/<name>.log"
