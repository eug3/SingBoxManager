#!/bin/bash
# service/(Go 二进制 + systemd) → 99号机。前端（Angular）由 scripts/deploy_console.sh 单独部署，本脚本不再上传页面
# 用法: ROUTER_PW='99号机口令' VAULT_KEY='clash secret' scripts/deploy_service.sh
# 说明: VAULT_KEY 只落到 99 的 /etc/vault-edit.env(0600)，不进仓库、不进二进制
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ROUTER_PW:?需要 ROUTER_PW（99号机 beijihu 口令）}"
: "${VAULT_KEY:?需要 VAULT_KEY（=两台路由 clash_api secret）}"
command -v sshpass >/dev/null || { echo "需要 sshpass"; exit 1; }
command -v go >/dev/null || { echo "需要 go 工具链"; exit 1; }

HOST="beijihu@192.168.31.99"
SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password -o ConnectTimeout=8"
retry() { local n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && { echo "   重试 $n 次仍失败"; return 1; }; sleep 1; done; }
R()     { retry sshpass -p "$ROUTER_PW" ssh $SSHOPT "$HOST" "$@"; }
U()     { retry sshpass -p "$ROUTER_PW" scp -q $SSHOPT "$@"; }

echo "== 1/5 交叉编译 linux/amd64"
cd "$ROOT/service"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/vault-edit-linux .
ls -l /tmp/vault-edit-linux | awk '{print "   二进制 "$5"B"}'

echo "== 2/5 准备上传物（unit / env / 安装脚本）"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp /tmp/vault-edit-linux "$STAGE/vault-edit.bin"
cp "$ROOT/service/vault-edit.service" "$STAGE/vault-edit.service"
{
  printf 'VAULT_KEY=%s\n' "$VAULT_KEY"
  # 规则桶存储（默认纯 Go SMB2，直连 NAS，不需要 cifs 挂载）
  [ -n "${SHARE_MODE:-}" ] && printf 'SHARE_MODE=%s\n' "$SHARE_MODE"
  [ -n "${SMB_ADDR:-}" ] && printf 'SMB_ADDR=%s\n' "$SMB_ADDR"
  [ -n "${SMB_SHARE:-}" ] && printf 'SMB_SHARE=%s\n' "$SMB_SHARE"
  [ -n "${SMB_PATH:-}" ] && printf 'SMB_PATH=%s\n' "$SMB_PATH"
  [ -n "${SMB_USER:-}" ] && printf 'SMB_USER=%s\n' "$SMB_USER"
  [ -n "${SMB_PASS:-}" ] && printf 'SMB_PASS=%s\n' "$SMB_PASS"
  [ -n "${SFTP_ADDR:-}" ] && printf 'SFTP_ADDR=%s\n' "$SFTP_ADDR"
  [ -n "${SFTP_PATH:-}" ] && printf 'SFTP_PATH=%s\n' "$SFTP_PATH"
  [ -n "${PUBLIC_BASE:-}" ] && printf 'PUBLIC_BASE=%s\n' "$PUBLIC_BASE"
} > "$STAGE/vault-edit.env"
printf '%s\n' "$ROUTER_PW" > "$STAGE/vault-edit.pw"
chmod 600 "$STAGE/vault-edit.pw"
cat > "$STAGE/install.sh" <<'EOF'
#!/bin/sh
set -e
ts=$(date +%Y%m%d-%H%M%S)
[ -f /usr/local/bin/vault-edit ] && cp /usr/local/bin/vault-edit "/usr/local/bin/vault-edit.bak-$ts"
install -m 0755 /tmp/vault-edit.bin /usr/local/bin/vault-edit
install -d -m 0755 /usr/local/share/vault-edit/edit
install -d -m 0755 /usr/local/share/vault-edit/static
install -m 0644 /tmp/vault-edit.service /etc/systemd/system/vault-edit.service
install -m 0600 -o root -g root /tmp/vault-edit.env /etc/vault-edit.env
systemctl daemon-reload
systemctl restart vault-edit
rm -f /tmp/vault-edit.bin /tmp/vault-edit.service /tmp/vault-edit.env /tmp/vault-edit-install.sh
echo "installed (backup: /usr/local/bin/vault-edit.bak-$ts)"
EOF

echo "== 3/5 一次 scp 上传全部（多次连续握手会被 sshd 掐断）"
cp "$STAGE/install.sh" "$STAGE/vault-edit-install.sh"
U "$STAGE/vault-edit.bin" "$STAGE/vault-edit.service" \
  "$STAGE/vault-edit.env" "$STAGE/vault-edit.pw" "$STAGE/vault-edit-install.sh" "$HOST:/tmp/"

echo "== 4/5 安装并重启 vault-edit（sudo 口令走 0600 临时文件，不进 argv）"
R "chmod 600 /tmp/vault-edit.pw && sudo -S -p '' sh /tmp/vault-edit-install.sh < /tmp/vault-edit.pw; rc=\$?; rm -f /tmp/vault-edit.pw /tmp/vault-edit-install.sh; exit \$rc"

echo "== 5/5 健康检查"
sleep 1
fail=0
chk() { local label="$1" url="$2" want="$3"
  got=$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$url" || echo 000)
  [ "$got" = "$want" ] && echo "   ✓ $label → $got" || { echo "   ✗ $label → $got（期望 $want）"; fail=1; }
}
chk "/health"                  "http://192.168.31.99:9099/health" 200
chk "/edit/ 页面"              "http://192.168.31.99:9099/edit/" 200
chk "/static/monaco"           "http://192.168.31.99:9099/static/monaco/vs/loader.js" 200
chk "/rule-set/<桶>.json"      "http://192.168.31.99:9099/rule-set/rs-tg.json" 200
chk "无 key 发布应被拒"        "http://192.168.31.99:9099/publish" 401
echo -n "   /health 内容: "; curl -s -m 6 http://192.168.31.99:9099/health; echo
[ "$fail" = 0 ] || { echo "部署完成但检查有失败项"; exit 1; }
echo "== 部署成功：管理台 http://192.168.31.99:9099/edit/"