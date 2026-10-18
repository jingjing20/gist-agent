#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo '请先配置项目根目录的 .env。'; exit 1; }
docker info >/dev/null 2>&1 || { echo '请先打开 Docker Desktop，待其启动后重试。'; exit 1; }
# Match the host ports published by docker-compose.yml without changing .env.
export DB_HOST=127.0.0.1
export DB_PORT=15432
export REDIS_URL=redis://127.0.0.1:16379
export APP_ORIGIN=http://localhost:5173
pnpm install --frozen-lockfile
pnpm --filter @gist/api... --filter @gist/worker... build
cleanup() {
    docker compose stop postgres redis
}
trap cleanup EXIT
docker compose up -d --wait postgres redis
pnpm init-db
echo 'Docker 数据库 + 本机应用：http://localhost:5173；按 Ctrl+C 停止应用和数据库（保留数据）。'
pnpm dev
