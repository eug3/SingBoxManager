#!/bin/bash
# web/console（Angular 22 + TS 前端）→ 99号机 /usr/local/share/vault-edit/edit
# 同时把 Monaco 编辑器（npm monaco-editor 的 min/vs）铺到 /usr/local/share/vault-edit/static/monaco/vs
# 用法: ROUTER_PW='99号机口令' scripts/deploy_console.sh
# 说明: 页面与编辑器都是静态文件，Go 服务无需重启；首次部署需要能访问 npm registry（之后走 /tmp 缓存）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ROUTER_PW:?需要 ROUTER_PW（99号机 beijihu 口令）}"
command -v sshpass >/dev/null || { echo "需要 sshpass"; exit 1; }
command -v npm >/dev/null || { echo "需要 npm"; exit 1; }
command -v tar >/dev/null || { echo "需要 tar"; exit 1; }

HOST="beijihu@192.168.31.99"
SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password -o ConnectTimeout=8"
retry() { local n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && { echo "   重试 $n 次仍失败"; return 1; }; sleep 1; done; }
R() { retry sshpass -p "$ROUTER_PW" ssh $SSHOPT "$HOST" "$@"; }
U() { retry sshpass -p "$ROUTER_PW" scp -q $SSHOPT "$@"; }

MONACO_VERSION="0.57.0"
PAGE_LOCAL="$ROOT/web/console/dist/console/browser"
MONACO_CACHE="/tmp/monaco-vendor-$MONACO_VERSION"

echo "== 1/6 构建 Angular（base-href=/edit/）"
cd "$ROOT/web/console"
[ -d node_modules ] || npm ci --silent
npx ng build --base-href=/edit/ 2>&1 | tail -6
[ -f "$PAGE_LOCAL/index.html" ] || { echo "构建产物缺失: $PAGE_LOCAL"; exit 1; }
du -sh "$PAGE_LOCAL" | awk '{print "   产物 "$1}'

echo "== 2/6 准备 Monaco 静态资源（$MONACO_VERSION）"
if [ ! -d "$MONACO_CACHE/vs" ]; then
  mkdir -p "$MONACO_CACHE" /tmp/monaco-pack
  if [ ! -f "/tmp/monaco-pack/monaco-editor-$MONACO_VERSION.tgz" ]; then
    (cd /tmp/monaco-pack && npm pack "monaco-editor@$MONACO_VERSION" --silent >/dev/null)
  fi
  tar xzf "/tmp/monaco-pack/monaco-editor-$MONACO_VERSION.tgz" -C "$MONACO_CACHE" package/min/vs
  mv "$MONACO_CACHE/package/min/vs" "$MONACO_CACHE/vs"
  rm -rf "$MONACO_CACHE/package"
fi
du -sh "$MONACO_CACHE/vs" | awk '{print "   monaco "$1}'

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
tar czf "$STAGE/page.tgz" -C "$PAGE_LOCAL" .
printf '%s\n' "$ROUTER_PW" > "$STAGE/deploy.pw"; chmod 600 "$STAGE/deploy.pw"

REMOTE_MONACO=$(R "cat /usr/local/share/vault-edit/static/monaco/VERSION 2>/dev/null || echo none" | tr -d '\r')
if [ "$REMOTE_MONACO" = "$MONACO_VERSION" ]; then
  echo "== 3/6 Monaco 远端已是 $MONACO_VERSION，跳过上传"
  NEED_MONACO=0
else
  echo "== 3/6 Monaco 远端=$REMOTE_MONACO → 上传 $MONACO_VERSION"
  tar czf "$STAGE/monaco.tgz" -C "$MONACO_CACHE" vs
  NEED_MONACO=1
fi

cat > "$STAGE/install.sh" <<'EOF'
#!/bin/sh
set -e
ts=$(date +%Y%m%d-%H%M%S)
PAGE=/usr/local/share/vault-edit/edit
STATIC=/usr/local/share/vault-edit/static
need_monaco="$1"

# 页面：先备份旧目录，再整体替换（Angular 产物是带 hash 的多文件，不能只覆盖 index.html）
[ -d "$PAGE" ] && cp -a "$PAGE" "$PAGE.bak-$ts"
mkdir -p "$PAGE"
find "$PAGE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar xzf /tmp/console-page.tgz -C "$PAGE"
chmod -R a+rX "$PAGE"

if [ "$need_monaco" = "1" ]; then
  mkdir -p "$STATIC/monaco"
  [ -d "$STATIC/monaco/vs" ] && mv "$STATIC/monaco/vs" "$STATIC/monaco/vs.bak-$ts"
  tar xzf /tmp/console-monaco.tgz -C "$STATIC/monaco"
  chmod -R a+rX "$STATIC/monaco/vs"
  printf '%s\n' "__MONACO_VERSION__" > "$STATIC/monaco/VERSION"
fi

rm -f /tmp/console-page.tgz /tmp/console-monaco.tgz /tmp/console-install.sh /tmp/console-deploy.pw
echo "installed page (backup: $PAGE.bak-$ts) need_monaco=$need_monaco"
EOF
sed -i '' "s/__MONACO_VERSION__/$MONACO_VERSION/" "$STAGE/install.sh" 2>/dev/null || sed -i "s/__MONACO_VERSION__/$MONACO_VERSION/" "$STAGE/install.sh"

echo "== 4/6 上传（页面 $(du -h "$STAGE/page.tgz" | awk '{print $1}')$([ "$NEED_MONACO" = 1 ] && echo " + monaco $(du -h "$STAGE/monaco.tgz" | awk '{print $1}')")）"
cp "$STAGE/install.sh" "$STAGE/console-install.sh"
if [ "$NEED_MONACO" = 1 ]; then
  U "$STAGE/page.tgz" "$STAGE/monaco.tgz" "$STAGE/deploy.pw" "$STAGE/console-install.sh" "$HOST:/tmp/"
  R "mv /tmp/page.tgz /tmp/console-page.tgz; mv /tmp/monaco.tgz /tmp/console-monaco.tgz; mv /tmp/deploy.pw /tmp/console-deploy.pw"
else
  U "$STAGE/page.tgz" "$STAGE/deploy.pw" "$STAGE/console-install.sh" "$HOST:/tmp/"
  R "mv /tmp/page.tgz /tmp/console-page.tgz; mv /tmp/deploy.pw /tmp/console-deploy.pw"
fi

echo "== 5/6 安装到 99"
R "chmod 600 /tmp/console-deploy.pw && sudo -S -p '' sh /tmp/console-install.sh $NEED_MONACO < /tmp/console-deploy.pw"

echo "== 6/6 校验"
fail=0
chk() { local label="$1" url="$2" want="$3"
  got=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$url" || echo 000)
  [ "$got" = "$want" ] && echo "   ✓ $label → $got" || { echo "   ✗ $label → $got（期望 $want）"; fail=1; }
}
chk "/edit/ 页面"        "http://192.168.31.99:9099/edit/" 200
chk "/static/loader.js"  "http://192.168.31.99:9099/static/monaco/vs/loader.js" 200
chk "/rule-set/json"     "http://192.168.31.99:9099/rule-set/rs-tg.json" 200
chk "/publish 无 key"    "http://192.168.31.99:9099/publish" 401
ASSET=$(curl -s -m 8 "http://192.168.31.99:9099/edit/" | grep -o 'main-[A-Z0-9]*\.js' | head -1 || true)
if [ -n "$ASSET" ]; then chk "首页引用的 /edit/$ASSET" "http://192.168.31.99:9099/edit/$ASSET" 200; else echo "   ✗ 首页没找到 main-*.js 引用"; fail=1; fi
echo -n "   /health: "; curl -s -m 6 http://192.168.31.99:9099/health; echo
[ "$fail" = 0 ] || { echo "部署完成但校验有失败项"; exit 1; }
echo "== 前端部署成功：http://192.168.31.99:9099/edit/"