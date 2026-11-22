#!/bin/bash
# 一键给 OpenWrt 路由安装 sing-box(从开发机推送,路由上无需预装任何东西)
# 用法:
#   ROUTER=192.168.31.32 ROUTER_PW='口令' scripts/install_openwrt_singbox.sh
# 可选环境变量:
#   ROUTER_PW         SSH 口令(空=假定公钥可用)
#   ROUTER_USER       SSH 用户(默认 root)
#   SINGBOX_VERSION   sing-box 版本(默认 1.14.4 最新稳定版;≤ 路由侧版本即可,.srs 向下兼容。
#                     要对齐 1.15 内测线填完整 tag 如 1.15.0-alpha.13)
#   CONFIG_JSON       本地 config.json 路径(推上去做初始配置;不填且路由无配置时用内置最小模板)
#   RULES_BASE        内置模板里的远程 rule-set 地址(默认 https://rules.example.com/rule-set/)
#   GH_PROXY          GitHub 下载镜像前缀(国内网络用,如 https://ghproxy.com)
# 装完的布局(与管理机 /router/* 的默认路径完全一致,装好即可被管理台接管):
#   二进制  /opt/sing-box/sing-box
#   服务    /etc/init.d/sing-box (procd, respawn)
#   配置    /etc/sing-box/config.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ROUTER:?需要 ROUTER(OpenWrt 路由地址,如 192.168.31.32)}"
ROUTER_USER="${ROUTER_USER:-root}"
SINGBOX_VERSION="${SINGBOX_VERSION:-1.14.4}"
RULES_BASE="${RULES_BASE:-https://rules.example.com/rule-set/}"
PORT="${PORT:-22}"

SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8"
if [ -n "${ROUTER_PW:-}" ]; then
  command -v sshpass >/dev/null || { echo "需要 sshpass(或清空 ROUTER_PW 走公钥)"; exit 1; }
  R() { sshpass -p "$ROUTER_PW" ssh -p "$PORT" $SSHOPT "$ROUTER_USER@$ROUTER" "$@"; }
  U() { sshpass -p "$ROUTER_PW" scp -P "$PORT" -q $SSHOPT "$@"; }
else
  R() { ssh -p "$PORT" $SSHOPT "$ROUTER_USER@$ROUTER" "$@"; }
  U() { scp -P "$PORT" -q $SSHOPT "$@"; }
fi

echo "== 1/7 探测路由(CPU 架构 / OpenWrt / 磁盘 / 旧安装)"
ARCH_RAW=$(R "uname -m" | tr -d '\r')
case "$ARCH_RAW" in
  x86_64)         ARCH=amd64 ;;
  aarch64|armv8l) ARCH=arm64 ;;
  armv7l|armv6l)  ARCH=armv7 ;;
  *) echo "不支持的架构: $ARCH_RAW(sing-box 官方 release 无对应包),到"
     echo "  https://github.com/SagerNet/sing-box/releases 自行确认后改本脚本的映射"; exit 1 ;;
esac
echo "   路由架构 $ARCH_RAW → sing-box linux_$ARCH"

OS_INFO=$(R ". /etc/openwrt_release 2>/dev/null && echo \"\$DISTRIB_DESCRIPTION\" || cat /etc/os-release | head -1" | tr -d '\r')
echo "   系统: $OS_INFO"
case "$OS_INFO" in *OpenWrt*|*openwrt*|*immortalwrt*|*ImmortalWrt*) ;; *) echo "   警告: 看起来不是 OpenWrt 系(init 脚本按 procd 写),继续但请自行验证" ;; esac

FREE_KB=$(R "df -k /opt 2>/dev/null | tail -1 | awk '{print \$4}'" | tr -d '\r')
[ "${FREE_KB:-0}" -ge 60000 ] || { echo "   /opt 所在分区剩余 ${FREE_KB:-?}KB,不足 60MB(sing-box 约 30MB + 解压余量);上 extroot 或换分区"; exit 1; }

if R "test -x /opt/sing-box/sing-box" 2>/dev/null; then
  OLD_VER=$(R "/opt/sing-box/sing-box version 2>/dev/null | head -1" | tr -d '\r')
  echo "   已有安装: $OLD_VER → 会备份为 sing-box.bak-<ts> 后覆盖(配置不动)"
fi

echo "== 2/7 本机下载 sing-box ${SINGBOX_VERSION} (linux_${ARCH})"
TEMP="$ROOT/.temp"; mkdir -p "$TEMP"
TARBALL="$TEMP/sing-box-${SINGBOX_VERSION}-linux-${ARCH}.tar.gz"
URL="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${ARCH}.tar.gz"
if [ ! -s "$TARBALL" ]; then
  DL="${GH_PROXY:+$GH_PROXY/}$URL"
  echo "   下载 $DL"
  curl -fL --retry 3 -o "$TARBALL" "$DL" || { echo "   下载失败:可设 GH_PROXY=https://<镜像> 重试"; exit 1; }
else
  echo "   复用缓存 $TARBALL"
fi
tar tzf "$TARBALL" >/dev/null || { rm -f "$TARBALL"; echo "   缓存损坏已删,重跑"; exit 1; }

echo "== 3/7 生成 init 脚本与默认配置(本地暂存)"
STAGE="$TEMP/stage-$$"; mkdir -p "$STAGE"; trap 'rm -rf "$STAGE"' EXIT
cat > "$STAGE/sing-box.init" <<'EOF'
#!/bin/sh /etc/rc.common
# procd 服务:sing-box run(vault-edit 管理机的 ROUTER_INIT 默认路径就是这里)
USE_PROCD=1
START=99
STOP=15

PROG=/opt/sing-box/sing-box
CONFFILE=/etc/sing-box/config.json
WORKDIR=/etc/sing-box

start_service() {
  procd_open_instance
  procd_set_param command "$PROG" run -c "$CONFFILE" -D "$WORKDIR"
  procd_set_param file "$CONFFILE"
  procd_set_param respawn
  procd_set_param respawn_threshold 3600
  procd_set_param respawn_retry 0
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_close_instance
}

reload_service() {
  stop
  start
}
EOF

if [ -n "${CONFIG_JSON:-}" ]; then
  [ -f "$CONFIG_JSON" ] || { echo "CONFIG_JSON 不存在: $CONFIG_JSON"; exit 1; }
  cp "$CONFIG_JSON" "$STAGE/config.json"
  echo "   初始配置来自 $CONFIG_JSON"
else
  # 兜底最小模板:能起服务 + clash_api + 两个远程规则桶示例。生产配置请从
  # 现有路由的 /etc/sing-box/config.json 复制或经管理台「配置」tab 编辑。
  cat > "$STAGE/config.json" <<EOF
{
  "log": { "level": "info", "timestamp": true },
  "experimental": {
    "clash_api": {
      "external_controller": "0.0.0.0:9090",
      "secret": "CHANGE_ME_CLASH_SECRET",
      "access_control_allow_origin": [
        "http://dash.lan:888",
        "http://console.lan:9099",
        "http://console-vpn.lan:9099"
      ],
      "access_control_allow_private_network": true
    },
    "cache_file": { "enabled": true, "path": "/etc/sing-box/cache.db" }
  },
  "route": {
    "rules": [
      { "rule_set": ["rs-direct"], "outbound": "direct" },
      { "rule_set": ["rs-proxy"], "outbound": "proxy" }
    ],
    "rule_set": [
      { "type": "remote", "tag": "rs-direct", "format": "binary",
        "url": "${RULES_BASE}rs-direct.srs", "update_interval": "1m" },
      { "type": "remote", "tag": "rs-proxy", "format": "binary",
        "url": "${RULES_BASE}rs-proxy.srs", "update_interval": "1m" }
    ]
  },
  "outbounds": [
    { "type": "selector", "tag": "proxy", "outbounds": ["direct"], "default": "direct" },
    { "type": "direct", "tag": "direct" }
  ]
}
EOF
  echo "   使用内置最小模板(务必改 secret / 换生产配置)"
fi

echo "== 4/7 上传(二进制 + init + 配置)"
tar czf "$STAGE/pkg.tgz" -C "$STAGE" sing-box.init config.json
U "$TARBALL" "$STAGE/pkg.tgz" "$ROUTER_USER@$ROUTER:/tmp/"

echo "== 5/7 安装(kmod-tun → /opt/sing-box → init → 配置)"
R "sh -s" < <(cat <<'REMOTE'
set -e
ts=$(date +%Y%m%d-%H%M%S)
ARCH_TARBALL=$(ls /tmp/sing-box-*-linux-*.tar.gz | head -1)

# TUN 内核模块(TUN 模式需要;装不了只告警)
if command -v opkg >/dev/null 2>&1; then
  opkg update >/dev/null 2>&1 || true
  opkg install kmod-tun >/dev/null 2>&1 || echo "   警告: kmod-tun 安装失败(TUN 模式可能不可用)"
fi
[ -e /dev/net/tun ] || echo "   警告: /dev/net/tun 不存在(TUN 模式不可用,普通代理不受影响)"

# 二进制 → /opt/sing-box(幂等,旧的备份)
mkdir -p /opt/sing-box
if [ -x /opt/sing-box/sing-box ]; then cp /opt/sing-box/sing-box /opt/sing-box/sing-box.bak-$ts; fi
tar xzf "$ARCH_TARBALL" -C /opt/sing-box --strip-components=1
chmod 0755 /opt/sing-box/sing-box
rm -f "$ARCH_TARBALL"

# init 脚本
tar xzf /tmp/pkg.tgz -C /tmp
install -m 0755 /tmp/sing-box.init /etc/init.d/sing-box
rm -f /tmp/pkg.tgz /tmp/sing-box.init /tmp/config.json.staged 2>/dev/null || true

# 配置:已有则不动(升级场景),没有才装初始配置
mkdir -p /etc/sing-box
if [ -f /etc/sing-box/config.json ]; then
  echo "   已有 /etc/sing-box/config.json,保留不覆盖(初始配置留在 /etc/sing-box/config.json.new)"
  mv /tmp/config.json /etc/sing-box/config.json.new
else
  install -m 0600 /tmp/config.json /etc/sing-box/config.json
fi
rm -f /tmp/config.json

/etc/init.d/sing-box enable
echo "   installed: $(/opt/sing-box/sing-box version | head -1) (backup: sing-box.bak-$ts)"
REMOTE
)

echo "== 6/7 启动并自检"
R "/etc/init.d/sing-box restart" || true
sleep 2
fail=0
chk() { local label="$1" cmd="$2" want="$3"
  got=$(R "$cmd" 2>/dev/null | head -c 200 || echo FAIL)
  case "$got" in *"$want"*) echo "   ✓ $label" ;; *) echo "   ✗ $label → $got"; fail=1 ;; esac
}
chk "进程存活"    "pgrep -f 'sing-box run' >/dev/null && echo ALIVE" "ALIVE"
chk "版本可执行"  "/opt/sing-box/sing-box version | head -1" "sing-box version"
chk "配置校验"    "/opt/sing-box/sing-box check -c /etc/sing-box/config.json && echo OK" "OK"
chk "clash_api 9090 监听" "netstat -ltn 2>/dev/null | grep -q ':9090' && echo LISTEN" "LISTEN"
chk "开机自启"    "test -e /etc/rc.d/S99sing-box && echo ENABLED" "ENABLED"

echo "== 7/7 后续动作(接进管理体系)"
cat <<TIP
   ✓ 装好了。接下来:
   1. 生产配置:从现有路由抄 /etc/sing-box/config.json(或用 CONFIG_JSON= 重跑),
      改 clash secret、remote rule-set 的 url;改完 check + restart
   2. CORS:config.json 的 access_control_allow_origin 要含管理台页面来源(精确 origin)
   3. 管理机接管:管理台 → 添加后端(地址 http://$ROUTER:9090 + secret),
      「配置」tab 填 SSH 凭据后即可远程 check/apply/重启/回滚
   4. 升级:SINGBOX_VERSION=<新版本> 重跑本脚本即可(配置不动,旧二进制自动备份)
TIP
[ "$fail" = 0 ] || { echo "有失败项,看上面 ✗"; exit 1; }
