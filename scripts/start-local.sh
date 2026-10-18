#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v brew >/dev/null || { echo '请先安装 Homebrew。'; exit 1; }
[[ -f .env ]] || { echo '请先配置项目根目录的 .env。'; exit 1; }
for formula in postgresql@17 redis; do
    brew list --versions "$formula" >/dev/null 2>&1 || brew install "$formula"
done
pnpm install --frozen-lockfile
pnpm --filter @gist/api... --filter @gist/worker... build
cleanup() {
    brew services stop postgresql@17
    brew services stop redis
}
trap cleanup EXIT
brew services start postgresql@17
brew services start redis
node scripts/init-local-db.mjs
echo '本机模式：http://localhost:5173；按 Ctrl+C 停止应用和数据库。'
pnpm dev
