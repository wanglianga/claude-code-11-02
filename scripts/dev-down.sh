#!/usr/bin/env bash
# 停止本地开发模式全部应用（保留 PostgreSQL/Redis 与数据）
ROOT=$(cd "$(dirname "$0")/.." && pwd)
for f in "$ROOT"/.pids/*; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  kill "$pid" 2>/dev/null && echo "stopped $(basename "$f") ($pid)"
  rm -f "$f"
done
exit 0
