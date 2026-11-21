#!/bin/bash
# CLI 发布: VAULT_KEY=xxx scripts/publish.sh <桶名> <json路径>
set -e
BUCKET="$1"; FILE="$2"
[ -z "$VAULT_KEY" ] || [ -z "$BUCKET" ] || [ -z "$FILE" ] && { echo "用法: VAULT_KEY=xxx $0 <bucket> <file.json>"; exit 1; }
python3 -c "import json,sys;json.load(open('$FILE'))" || { echo "JSON 语法错误"; exit 1; }
curl -s -m 20 -X POST -H "Content-Type: application/json" -H "X-Vault-Key: $VAULT_KEY" \
  --data-binary "$(python3 -c "import json;print(json.dumps({'bucket':'$BUCKET','content':open('$FILE').read()}))")" \
  http://192.168.31.99:9099/publish
echo
