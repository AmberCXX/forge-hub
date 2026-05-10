#!/bin/bash
# OSS → 运行时 单向同步 + Hub 重启
# 这是唯一的同步工具。不提供反向操作。
# 用法: bash scripts/sync-to-runtime.sh

set -e
cd "$(dirname "$0")/.."

HUB_RUNTIME="${HOME}/.forge-hub/source"
CLIENT_RUNTIME="${HOME}/.claude/自动化/channels/hub"
CLI_RUNTIME="${HOME}/.forge-hub/cli"

echo "🔄 OSS → 运行时同步"
echo ""

# hub-server
mkdir -p "$HUB_RUNTIME/routes" "$HUB_RUNTIME/channels"
for f in hub-server/*.ts; do
  [ -f "$f" ] && cp "$f" "$HUB_RUNTIME/$(basename $f)"
done
for f in hub-server/routes/*.ts; do
  [ -f "$f" ] && cp "$f" "$HUB_RUNTIME/routes/$(basename $f)"
done
for f in hub-server/channels/*.ts; do
  [ -f "$f" ] && cp "$f" "$HUB_RUNTIME/channels/$(basename $f)"
done
echo "✓ hub-server"

# hub-client
mkdir -p "$CLIENT_RUNTIME"
cp hub-client/hub-channel.ts "$CLIENT_RUNTIME/hub-channel.ts"
cp hub-client/session-config.ts "$CLIENT_RUNTIME/session-config.ts"
echo "✓ hub-client"

# forge-cli
mkdir -p "$CLI_RUNTIME"
cp forge-cli/forge.ts "$CLI_RUNTIME/forge.ts"
echo "✓ forge-cli"

# 验证
echo ""
bash scripts/check-runtime-sync.sh

# 重启 Hub
echo ""
read -p "重启 Hub？(y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  HUB_PID=$(cat "${HOME}/.forge-hub/hub.pid" 2>/dev/null)
  if [ -n "$HUB_PID" ]; then
    kill "$HUB_PID" 2>/dev/null || true
    sleep 2
  fi
  launchctl kickstart "gui/$(id -u)/com.forge.hub" 2>/dev/null || true
  sleep 3
  curl -s --connect-timeout 2 http://localhost:9900/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'✓ Hub 已重启 (uptime: {d.get(\"uptime\",\"?\")}s)')" 2>/dev/null || echo "⚠ Hub 未响应"
fi
