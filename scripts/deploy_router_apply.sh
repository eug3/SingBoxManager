#!/usr/bin/env bash
# 把 service/router/singbox-apply 安装到两台路由的 /usr/local/sbin/（0755, root:root）
#
# 用法:
#   R32_PW='甲口令' GL_PW='乙口令' scripts/deploy_router_apply.sh
#   R32_PW='...' GL_PW='...' scripts/deploy_router_apply.sh 192.168.31.32   # 只装一台
#
# 说明: 该脚本只做「上传 + 校验 sha256」，不碰 sing-box 配置、不重启服务。
set -u
cd "$(dirname "$0")/.."
SRC=service/router/singbox-apply
R32=${R32_PW:?需要 R32_PW（甲 32 root 口令）}
GL=${GL_PW:?需要 GL_PW（乙 GL root 口令）}
HOSTS=("${@:-}")
if [ "${#HOSTS[@]}" -eq 1 ] && [ -z "${HOSTS[0]}" ]; then
  HOSTS=(192.168.31.32 172.16.8.1)
fi

sha=$(shasum -a 256 "$SRC" | awk '{print $1}')
echo "本地 $SRC sha256=$sha"

install_one() {
  local host="$1" pw="$2" i out
  for i in 1 2 3 4 5; do
    out=$(SSHPASS="$pw" sshpass -e ssh -T \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 \
      "root@$host" \
      'mkdir -p /usr/local/sbin && cat > /tmp/singbox-apply && \
       cp /tmp/singbox-apply /usr/local/sbin/singbox-apply && \
       chmod 0755 /usr/local/sbin/singbox-apply && chown root:root /usr/local/sbin/singbox-apply && \
       rm -f /tmp/singbox-apply && sha256sum /usr/local/sbin/singbox-apply | cut -d" " -f1' \
      < "$SRC" 2>/dev/null | tail -1)
    if [ "$out" = "$sha" ]; then
      echo "  ✓ $host 已安装（sha 一致）"
      return 0
    fi
    sleep 2
  done
  echo "  ✗ $host 安装失败（最后输出: ${out:-空}）"
  return 1
}

rc=0
for h in "${HOSTS[@]}"; do
  case "$h" in
    192.168.31.32) install_one "$h" "$R32" || rc=1 ;;
    172.16.8.1) install_one "$h" "$GL" || rc=1 ;;
    *) echo "  ? 未知 host $h（只支持 192.168.31.32 / 172.16.8.1）"; rc=1 ;;
  esac
done
exit $rc