#!/bin/bash
# 链路体检：管理台（双入口）/ 公网只读 / 桶 URL / 双路由 clash-api+CORS / NAS 挂载
# 用法: VAULT_KEY=xxx scripts/check.sh
KEY="${VAULT_KEY:-}"
LAN_ORIGIN="http://192.168.31.99:9099"
ET_ORIGIN="http://10.1.1.99:9099"
OLD_ORIGIN="http://192.168.31.8:888"

# 1) 管理台本体：健康、双入口页面、桶源、Monaco、Angular 入口、鉴权
echo "== 管理台 99:9099 =="
curl -s -m 5 http://192.168.31.99:9099/health; echo
printf "  LAN 入口 /edit/      %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 $LAN_ORIGIN/edit/)"
printf "  EasyTier 入口 /edit/ %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 6 $ET_ORIGIN/edit/)"
printf "  /rule-set/*.json     %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://192.168.31.99:9099/rule-set/rs-tg.json)"
printf "  Monaco loader        %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 6 http://192.168.31.99:9099/static/monaco/vs/loader.js)"
ASSET=$(curl -s -m 6 http://192.168.31.99:9099/edit/ | grep -o 'main-[A-Z0-9]*\.js' | head -1)
[ -n "$ASSET" ] && printf "  Angular 入口 %-8s %s\n" "$ASSET" "$(curl -s -o /dev/null -w '%{http_code}' -m 6 http://192.168.31.99:9099/edit/$ASSET)"
printf "  /publish 无 key      %s（应 401）\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://192.168.31.99:9099/publish)"

# 2) 公网边界：管理台必须 404，首页与桶源必须 200
echo "== 公网只读（应 /edit/ 404、首页 200）=="
printf "  public /edit/ %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 8 https://router.guaishoudejia.com/edit/)"
printf "  public /      %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 8 https://router.guaishoudejia.com/)"
for b in rs-tg rs-media bard-domains; do
  curl -s -m 6 -o /dev/null -w "  桶 $b %{http_code} %{size_download}B\n" "https://router.guaishoudejia.com/rule-set/$b.srs"
done

# 3) 两台路由：clash_api 可达 + 三个页面来源都在 CORS 白名单里
echo "== 路由 clash-api 与 CORS 来源 =="
for R in 192.168.31.32 172.16.8.1; do
  printf "  %-14s" "$R"
  if [ -z "$KEY" ]; then echo " （未设 VAULT_KEY，跳过）"; continue; fi
  printf " /proxies=%s" "$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H "Authorization: Bearer $KEY" "http://$R:9090/proxies")"
  for O in $OLD_ORIGIN $LAN_ORIGIN $ET_ORIGIN; do
    n=$(curl -s -D - -o /dev/null -m 8 -X OPTIONS -H "Origin: $O" -H "Access-Control-Request-Method: GET" "http://$R:9090/version" | grep -ci 'access-control-allow-origin')
    printf " · ACAO[$O]=%s" "$n"
  done
  echo
done

# 4) 规则桶通道：99 直接用纯 Go SMB2 读 NAS（不需要 cifs 挂载）
echo "== 规则桶通道（/share/health）=="
curl -s -m 25 http://192.168.31.99:9099/share/health | python3 -c "
import json,sys
d=json.load(sys.stdin); f=d['file']; h=d['http']
print('  文件通道 %s → %s（%d 文件, 样本 %s %dB, %dms）' % (f['mode'], '✓' if f['ok'] else '✗ '+str(f.get('error')), f['files'], f['sample'], f['size'], f['ms']))
print('  公网 URL %s → %s %s（%dB, %dms）' % (h['url'], '✓' if h['ok'] else '✗ '+str(h.get('error')), h['status'], h['size'], h['ms']))
" 2>/dev/null || echo "  /share/health 不可用（服务未部署该版本？）"
# 开发机本地 NAS 挂载只剩方便手工看文件，不再参与发布链路
echo "== 开发机 NAS 挂载（可选）=="
[ -d /Volumes/HddShare/WebEdit/rule-set ] && echo "  /Volumes/HddShare OK（仅本地便利，发布走 SMB 客户端）" || echo "  未挂载（不影响发布）"