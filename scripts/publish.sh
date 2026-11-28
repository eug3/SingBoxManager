#!/bin/bash
# CLI 发布: VAULT_KEY=xxx scripts/publish.sh <桶名> <json路径>
# 本地先验 JSON 语法，再 POST /publish（content 以字符串形态传，服务端兼容）
# 服务端会做结构校验 + sing-box 编译，失败不会写 NAS
#
# 约定：VAULT_KEY 只从环境变量读，不落盘、不进命令行参数（ps 看不到）。
set -euo pipefail

CONSOLE="${CONSOLE:-http://192.168.31.99:9099}"
BUCKET="${1:-}"; FILE="${2:-}"

# 三个参数缺一不可（原写法 || 与 && 同级左结合，只缺 VAULT_KEY 时会漏过检查）
if [ -z "${VAULT_KEY:-}" ] || [ -z "$BUCKET" ] || [ -z "$FILE" ]; then
  echo "用法: VAULT_KEY=xxx $0 <bucket> <file.json>" >&2
  exit 1
fi
[ -f "$FILE" ] || { echo "文件不存在: $FILE" >&2; exit 1; }

# 桶名白名单与服务端 bucketRe 一致（防止手滑传到非法路径）
case "$BUCKET" in
  rs-[a-z0-9-]*|bard-domains) ;;
  *) echo "桶名不合法（应为 rs-xxx 或 bard-domains）: $BUCKET" >&2; exit 1 ;;
esac

# 路径一律经 argv 传给 python，不拼进源码字符串（文件名含引号/空格也安全）
python3 - "$FILE" <<'PY' || { echo "JSON 语法错误" >&2; exit 1; }
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    json.load(f)
PY

# 组装请求体到临时文件再发：避免 --data-binary "$(…)" 把整份内容塞进命令行
BODY="$(mktemp -t publish-body.XXXXXX)"
trap 'rm -f "$BODY"' EXIT
python3 - "$BUCKET" "$FILE" "$BODY" <<'PY'
import json, sys
bucket, path, out = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    content = f.read()
with open(out, "w", encoding="utf-8") as f:
    json.dump({"bucket": bucket, "content": content}, f, ensure_ascii=False)
PY

curl -sS -m 60 -X POST \
  -H "Content-Type: application/json" \
  -H "X-Vault-Key: ${VAULT_KEY}" \
  --data-binary "@$BODY" \
  "$CONSOLE/publish"
echo
