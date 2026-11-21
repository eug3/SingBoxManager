#!/bin/bash
# web/index.html → NAS WebEdit/index.html（首页/桶状态页，公网同目录可见，已脱敏）
# 管理台（编辑/发布）不在 NAS：它在 99号机 http://192.168.31.99:9099/edit/，用 scripts/deploy_service.sh 部署
set -e
DST="${NAS_DST:-/Volumes/HddShare/WebEdit}"
[ -d "$DST" ] || { echo "NAS 未挂载（$DST 不存在），先访问 smb://192.168.31.8/HddShare"; exit 1; }
cp web/index.html "$DST/index.html"
echo "已部署首页: $DST/index.html"
echo "注意：NAS nginx 有 ~1min 文件句柄缓存，下断言前等 1-2 分钟或多探两次"
curl -s -m 5 -o /dev/null -w "首页 -> %{http_code}\n" "http://192.168.31.8:888/?$(date +%s)"