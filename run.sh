#!/usr/bin/env bash
# Thin wrapper: run the bridge assuming `opencode serve` is already on $OPENCODE_SERVER_URL.
# Use ./start.sh if you also need to boot a dedicated opencode server.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
[ -f .env ] && set -a && . ./.env && set +a
exec /Users/xing/.bun/bin/bun run src/index.ts
