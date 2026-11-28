#!/bin/bash
# 链路体检：管理台（双入口 + 登录门）/ 公网只读 / 桶 URL / 双路由 clash-api+CORS / 规则桶通道
# 用法: scripts/check.sh                       # 基础体检（不需要任何口令）
#       LOGIN_PW=xxx scripts/check.sh          # 额外验证登录门（登录后能拿到页面与入口资源）
#       VAULT_KEY=xxx scripts/check.sh         # 额外验证路由 clash-api 与 CORS
# 退出码：0 全部通过；1 有 ✗。每一行都自带「应为什么」，便于一眼看出哪项坏了。
set -u
KEY="${VAULT_KEY:-}"
PW="${LOGIN_PW:-}"
LAN_ORIGIN="http://192.168.31.99:9099"
ET_ORIGIN="http://10.1.1.99:9099"
LEGACY_ORIGIN="http://192.168.31.8:888"   # 旧入口：Go 服务已不认，但路由 CORS 白名单里还留着
PUBLIC="https://router.guaishoudejia.com"
FAIL=0
JAR="$(mktemp -t check-cookies.XXXXXX)"
trap 'rm -f "$JAR"' EXIT

# ok <标签> <实际> <期望>：相等打 ✓，否则打 ✗ 并记一次失败
ok() { if [ "$2" = "$3" ]; then printf "  ✓ %-34s %s\n" "$1" "$2"; else printf "  ✗ %-34s %s（应 %s）\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi; }
# code [-X 方法] [-b jar] <URL> [超时]：只回状态码；curl 出错回 000
code() { curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

echo "== 管理台 99:9099 =="
printf "  · /health  %s\n" "$(curl -s -m 5 http://192.168.31.99:9099/health)"
# 登录门：未登录访问页面必须被重定向到 /login（302），而不是 200 直接给页面
ok "LAN 入口 未登录 /edit/ → 302"   "$(code $LAN_ORIGIN/edit/)" 302
ok "EasyTier 入口 未登录 /edit/ →302" "$(code $ET_ORIGIN/edit/)"  302
ok "登录页 /login 可达"            "$(code $LAN_ORIGIN/login)"   200
ok "API 未带密钥 → 401"            "$(code $LAN_ORIGIN/router/config?host=127.0.0.1)" 401
ok "/publish 无 key → 401"         "$(code -X POST -m 5 $LAN_ORIGIN/publish)" 401
# /edit/ 未登录是 302，拿不到 HTML；真正要验的是登录页本身是 HTML
ok "登录页回 HTML" "$(curl -s -m 6 -o /dev/null -w '%{content_type}' $LAN_ORIGIN/login | cut -d';' -f1)" "text/html"
# 登录门后面还有两样东西：Monaco 静态资源（配置编辑器靠它）与存储体检接口 —— 未登录必须被拦。
# 应答分两类（loginWantsHTML 的设计）：页面/静态资源 → 302 跳 /login；接口 → 401 JSON
ok "Monaco loader 未登录 → 302"   "$(code -m 8 $LAN_ORIGIN/static/monaco/vs/loader.js)" 302
ok "/share/health 未登录 → 401"   "$(code -m 25 $LAN_ORIGIN/share/health)" 401

if [ -n "$PW" ]; then
  # 登录后：页面 200、入口资源存在、/logout 能清会话
  R="$(curl -s -m 8 -c "$JAR" -o /dev/null -w '%{http_code}' -d "password=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PW")" $LAN_ORIGIN/login)"
  ok "登录 POST → 302" "$R" 302
  ok "登录后 /edit/ → 200" "$(code -b "$JAR" $LAN_ORIGIN/edit/)" 200
  ASSET=$(curl -s -m 6 -b "$JAR" $LAN_ORIGIN/edit/ | grep -o 'main-[A-Z0-9]*\.js' | head -1)
  if [ -n "$ASSET" ]; then
    ok "Angular 入口 $ASSET" "$(code -b "$JAR" $LAN_ORIGIN/edit/$ASSET)" 200
  else
    printf "  ✗ %-34s 登录后的 /edit/ 里没找到 main-*.js（产物或 index.html 有问题）\n" "Angular 入口"; FAIL=$((FAIL+1))
  fi
  ok "登录后 Monaco loader → 200"   "$(code -b "$JAR" -m 8 $LAN_ORIGIN/static/monaco/vs/loader.js)" 200
  ok "登录后 /share/health → 200"   "$(code -b "$JAR" -m 25 $LAN_ORIGIN/share/health)" 200

  echo "  -- 规则桶通道（/share/health，用当前登录会话）--"
  curl -s -m 25 -b "$JAR" http://192.168.31.99:9099/share/health | python3 -c "
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception as e:
    print('  ✗ /share/health 不是 JSON（%s）：%s' % (e, raw[:120])); sys.exit(1)
if 'file' not in d or 'http' not in d:
    print('  ✗ /share/health 结构不对：' + json.dumps(d, ensure_ascii=False)[:160]); sys.exit(1)
f=d['file']; h=d['http']
print('  文件通道 %s → %s（%d 文件, 样本 %s %dB, %dms）' % (f['mode'], '✓' if f['ok'] else '✗ '+str(f.get('error')), f['files'], f['sample'], f['size'], f['ms']))
print('  公网 URL %s → %s %s（%dB, %dms）' % (h['url'], '✓' if h['ok'] else '✗ '+str(h.get('error')), h['status'], h['size'], h['ms']))
sys.exit(0 if (f['ok'] and h['ok']) else 1)
" || FAIL=$((FAIL+1))
  # -c 必须带上：/logout 靠 Set-Cookie(Max-Age=0) 清会话，不回写 jar 的话下一步仍带着旧 cookie（假阴性）
  ok "登录后 /logout → 302" "$(code -b "$JAR" -c "$JAR" $LAN_ORIGIN/logout)" 302
  ok "登出后 /edit/ → 302"  "$(code -b "$JAR" $LAN_ORIGIN/edit/)" 302
else
  echo "  · 登录门仅做未登录断言（要验登录后 Monaco / 存储体检 / 资源哈希：LOGIN_PW=口令 $0）"
fi

echo "== 公网只读（应 /edit/ 404、首页与桶 200）=="
ok "public /edit/ → 404" "$(code -m 10 $PUBLIC/edit/)" 404
ok "public / → 200"      "$(code -m 10 $PUBLIC/)" 200
for b in rs-tg rs-media bard-domains; do
  c="$(code -m 8 $PUBLIC/rule-set/$b.srs)"
  if [ "$c" = "200" ]; then printf "  ✓ %-34s %s\n" "桶 $b.srs" "$c"; else printf "  ✗ %-34s %s（应 200）\n" "桶 $b.srs" "$c"; FAIL=$((FAIL+1)); fi
done

echo "== 路由 clash-api 与 CORS =="
if [ -z "$KEY" ]; then
  echo "  · 未设 VAULT_KEY，跳过（要验：VAULT_KEY=clash密钥 $0）"
else
  for R in 192.168.31.32 172.16.8.1; do
    printf "  %-14s" "$R"
    printf " /version=%s" "$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H "Authorization: Bearer $KEY" "http://$R:9090/version")"
    for O in $LAN_ORIGIN $ET_ORIGIN; do
      n=$(curl -s -D - -o /dev/null -m 8 -X OPTIONS -H "Origin: $O" -H "Access-Control-Request-Method: GET" "http://$R:9090/version" | grep -ci 'access-control-allow-origin')
      if [ "$n" -ge 1 ]; then printf " · %s ✓" "${O#http://}"; else printf " · %s ✗" "${O#http://}"; FAIL=$((FAIL+1)); fi
    done
    n=$(curl -s -D - -o /dev/null -m 8 -X OPTIONS -H "Origin: $LEGACY_ORIGIN" -H "Access-Control-Request-Method: GET" "http://$R:9090/version" | grep -ci 'access-control-allow-origin')
    printf " · 旧来源=%s（信息项，路由白名单里仍保留）\n" "$([ "$n" -ge 1 ] && echo 在 || echo 不在)"
  done
fi


echo
if [ "$FAIL" -eq 0 ]; then echo "全部通过"; else echo "有 $FAIL 项异常（见上）"; fi
exit $((FAIL > 0))
