#!/usr/bin/env bash
#
# switch-tunnel.sh — 把 cpf-manager.xyz 的 DNS CNAME 切到指定 tunnel
#
# 用法：
#   ./scripts/switch-tunnel.sh <tunnel-id>
#   ./scripts/switch-tunnel.sh 24341696-3a8f-47dd-8737-933ff80f4801
#
# 作用：避免「DNS 漂移」—— 多台机器同时有 tunnel 时，确保只有一台在对外提供服务
# 适用：macOS / Linux（Windows 用 deploy-windows.ps1 自动处理）
#
# 前置：
#   1. 已 cloudflared tunnel login（有 ~/.cloudflared/cert.pem）
#   2. cpf-manager.xyz 在 Cloudflare 的 zone b9d212f1eda65aec73544576343147e7 下
#   3. tunnel id 是 32 位 UUID
#
set -euo pipefail

TUNNEL_ID="${1:-}"
ZONE_ID="b9d212f1eda65aec73544576343147e7"
RECORD_NAME="cpf-manager.xyz"
CERT="${HOME}/.cloudflared/cert.pem"

if [ -z "$TUNNEL_ID" ]; then
  echo "用法: $0 <tunnel-id>"
  echo "    例如: $0 24341696-3a8f-47dd-8737-933ff80f4801"
  echo ""
  echo "当前所有 tunnel:"
  cloudflared tunnel list 2>&1 | tail -n +2
  exit 1
fi

if [ ! -f "$CERT" ]; then
  echo "✗ 没找到 $CERT，请先 cloudflared tunnel login" >&2
  exit 1
fi

# 解码 Argo Tunnel Token 拿 API token
API_TOKEN=$(grep -v 'BEGIN\|END' "$CERT" | tr -d '\n' | base64 -d | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['apiToken'])")

TARGET="${TUNNEL_ID}.cfargotunnel.com"

echo "==[ switch-tunnel ]=="
echo "  Zone:       $ZONE_ID"
echo "  Record:     $RECORD_NAME"
echo "  Old target: 见下方查询"
echo "  New target: $TARGET"
echo ""

# 1) 列出当前 cpf-manager.xyz 下的所有记录（A + CNAME + Tunnel）
echo "--- 当前 DNS 记录 ---"
curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$RECORD_NAME" \
  -H "Authorization: Bearer $API_TOKEN" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
for r in d['result']:
    print(f\"  [{r['type']}] {r['name']} → {r['content']}  (id={r['id']})\")
"

# 2) 找记录 id 并 PATCH
RECORD_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=CNAME&name=$RECORD_NAME" \
  -H "Authorization: Bearer $API_TOKEN" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d['result'] else '')")

if [ -z "$RECORD_ID" ]; then
  echo "✗ 没找到 CNAME 记录，请先在 Cloudflare Dashboard 添加" >&2
  exit 1
fi

echo ""
echo "--- 切换 CNAME ---"
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"CNAME\",\"name\":\"$RECORD_NAME\",\"content\":\"$TARGET\",\"proxied\":true,\"ttl\":1}" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('success'):
    r = d['result']
    print(f\"  ✓ {r['type']} {r['name']} → {r['content']}\")
    print(f\"    proxied={r['proxied']}, ttl={r['ttl']}\")
else:
    print(f\"  ✗ 失败: {d.get('errors')}\")
    sys.exit(1)
"

echo ""
echo "--- 验证（dig）---"
sleep 2
dig "$RECORD_NAME" +noall +answer | head -5

echo ""
echo "--- 验证 tunnel 在线 ---"
cloudflared tunnel info "$TUNNEL_ID" 2>&1 | head -8

echo ""
echo "✓ 切换完成。DNS 5 秒内全球生效。"
