# 部署手册（vault-edit + 管理台 + 路由侧）

> 目标读者：拿到这台 Mac 与内网权限的人。所有命令都在**本仓库根目录**执行。
> 密钥只走环境变量，**任何一步都不要把口令写进仓库文件**。

## 0. 拓扑与角色

| 角色 | 机器 | 说明 |
|---|---|---|
| 控制台/写通道 | 99 号机 `192.168.31.99`（Debian） | `vault-edit` Go 服务（`:9099`，systemd）；挂载 NAS 到 `/mnt/hdd`；带 `sing-box` 编译器 |
| 规则仓库 | NAS `HddShare/WebEdit/` | `rule-set/*.json|*.srs`、`index.html`（公网首页）、`zashboard/` |
| 路由甲 | `192.168.31.32`（OpenWrt x86_64） | sing-box 1.15，TUN 分流，remote rule-set 每 60s 拉取 |
| 路由乙 | `172.16.8.1`（GL-BE3600 aarch64） | 同上，另一套 WiFi 网段 |
| 开发机 | Mac | `go` / `node` / `sshpass` / `npm` |

部署只有三个「可独立发版」的单元：**后端（Go）**、**前端（Angular）**、**公网首页（NAS 静态）**；路由侧只是配置项。

## 1. 前置检查

```bash
go version      # ≥ 1.27（service/go.mod 锁 1.27.4）
node -v         # ≥ 24（Angular 22 构建）
npm -v
which sshpass
```

99 号机需要：可用 sudo、`/mnt/hdd` 已挂 NAS、`/usr/local/bin/sing-box` 可执行：

```bash
ssh beijihu@192.168.31.99
sudo -n true && echo sudo-ok
mount | grep /mnt/hdd          # 应为 cifs 挂载
/usr/local/bin/sing-box version | head -1
sudo systemctl status vault-edit --no-pager
```

## 2. 99 号机一次性初始化（新机器才会用到）

> 已有机器跳过；`deploy_service.sh` 会自动创建目录、写 env、装 unit。

```bash
# 2.1 目录
sudo install -d -m 0755 /usr/local/share/vault-edit/edit /usr/local/share/vault-edit/static

# 2.2 密钥（0600，只有 root 可读；服务通过 systemd EnvironmentFile 注入）
sudo sh -c 'printf "VAULT_KEY=%s\n" "<clash_api secret>" > /etc/vault-edit.env'
sudo chmod 600 /etc/vault-edit.env

# 2.3 NAS 挂载（fstab 持久；guest 只读+写目录）
#    //<nas>/HddShare /mnt/hdd cifs guest,uid=beijihu,gid=users,iocharset=utf8,nofail 0 0

# 2.4 systemd：unit 随仓库 service/vault-edit.service 一起由 deploy_service.sh 安装
sudo systemctl enable --now vault-edit
sudo ss -ltnp | grep 9099
```

服务端可配置的环境变量（`Environment=`/`EnvironmentFile=`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN` | `:9099` | 监听地址（只在内网暴露，别改成 `0.0.0.0` 供公网） |
| `SHARE_DIR` | `/mnt/hdd/WebEdit/rule-set` | rule-set 桶目录 |
| `PAGE_DIR` | `/usr/local/share/vault-edit/edit` | Angular 前端产物目录 |
| `STATIC_DIR` | `/usr/local/share/vault-edit/static` | Monaco 等静态资源 |
| `SINGBOX` | `/usr/local/bin/sing-box` | 编译 `.srs` 用 |
| `VAULT_KEY` | **必填** | `X-Vault-Key` 校验；缺失服务拒绝启动 |

## 3. 发布后端（Go 服务）

```bash
export ROUTER_PW='99号机口令'
export VAULT_KEY='<clash_api secret>'
scripts/deploy_service.sh
```

脚本做的事：交叉编译 `linux/amd64` → 一次 scp（二进制 + unit + env + 安装脚本 + 0600 口令文件）→ 远端 `sudo` 安装（备份旧二进制 `vault-edit.bak-<ts>`）→ `systemctl restart vault-edit` → 健康检查。

通过时的输出：

```
✓ /health → 200
✓ /edit/ 页面 → 200
✓ /static/monaco → 200        # 首次部署前端之前这里是 404，正常
✓ /rule-set/<桶>.json → 200
✓ 无 key 发布应被拒 → 401
```

> 只改前端时**不要**跑这个脚本（会白白重启服务）。

## 4. 发布前端（Angular 管理台 + Monaco）

```bash
export ROUTER_PW='99号机口令'
scripts/deploy_console.sh
```

做的事：

1. `cd web/console && npx ng build --base-href=/edit/`（首次会 `npm ci`）；
2. 首次或版本变化时，从 npm registry 取 `monaco-editor@0.57.0` 的 `min/vs` 打包上传到 `/usr/local/share/vault-edit/static/monaco/vs`（之后按 `VERSION` 文件跳过，缓存留在 `/tmp/monaco-pack`）；
3. 内联 tar 上传 → 远端 `sudo`：**备份旧目录** `edit.bak-<ts>` → 清空 → 解包 → 修正权限；
4. 校验 `/edit/`、`/static/monaco/vs/loader.js`、首页引用的 `main-*.js`、`/rule-set/json`、`/publish` 401。

**不需要重启 Go 服务**（纯静态文件替换）。改完浏览器强刷即可（`index.html` 是 `no-store`，带 hash 的资源按名加载）。

## 5. 发布公网首页（NAS 静态）

```bash
scripts/deploy_web.sh      # 只上传 web/index.html → NAS WebEdit/index.html
```

注意：NAS 的 nginx 有约 1 分钟的句柄缓存，发布后可能短暂拿到旧页面；Cloudflare 侧另有缓存，必要时 purge。

`WebEdit/` 目录现状：`index.html`（脱敏首页）+ `rule-set/`（桶）+ `zashboard/`（备选看板）。**管理台不在公网**，`https://router.guaishoudejia.com/edit/` 应返回 404。

## 6. 路由侧配置（甲 32 / 乙 GL）

### 6.1 remote rule-set 指向 NAS

两台 `config.json` 的 `route.rule_set[]` 均为 `type: remote`、`format: binary`、`url: https://router.guaishoudejia.com/rule-set/<桶>.srs`、`update_interval: 1m`。换域名/NAS 时改这里，**改完必须 `sing-box check` + 重启**。

### 6.2 页面来源白名单（CORS）

管理台浏览器直连 `clash_api`，所以两台都要放行页面来源：

```json
"access_control_allow_origin": ["http://192.168.31.8:888",
                                "http://192.168.31.99:9099",
                                "http://10.1.1.99:9099"],
"access_control_allow_private_network": true
```

改配置的标准动作（两台同）：

```bash
cp /etc/sing-box/config.json /etc/sing-box/config.json.bak-$(date +%Y%m%d-%H%M%S)-before-origin
# 编辑 access_control_allow_origin（32 是 2 空格缩进 + LF；GL 是 1 空格缩进 + CRLF，别改格式）
/opt/sing-box/sing-box check -c /etc/sing-box/config.json
/etc/init.d/sing-box restart
```

> origin 必须是**精确的 `协议://主机:端口`**，写 `10.1.1.0/24` 这类网段无效。

### 6.3 验证 CORS

```bash
for R in 192.168.31.32 172.16.8.1; do
  for O in http://192.168.31.8:888 http://192.168.31.99:9099 http://10.1.1.99:9099 http://evil.example; do
    printf "%-14s %-28s ACAO=%s\n" "$R" "$O" \
      "$(curl -s -D - -o /dev/null -m 8 -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: GET' \
         "http://$R:9090/version" | grep -ci '^access-control-allow-origin')"
  done
done
# 期望：前三个 1，evil 为 0
```

### 6.4 启用 API service（可选，需重启）

sing-box 1.15 的 `services[{type:"api"}]` 提供比 Clash API 更全的运行时观测/操作，**但没有 reload 能力**。

```json
"services": [
  { "type": "api", "tag": "api", "listen": "0.0.0.0", "listen_port": 9092,
    "secret": "<与 clash_api 相同>",
    "access_control_allow_origin": ["http://192.168.31.8:888",
                                    "http://192.168.31.99:9099",
                                    "http://10.1.1.99:9099"],
    "access_control_allow_private_network": true }
]
```

- 端口避开占用项（32 的 9091 被容器占用 → 统一 9092）；
- 追加时保持原缩进与行尾（32：2 空格+LF；GL：1 空格+CRLF）；
- 生效流程：`sing-box check` → 重启 → 双端口验证（9090 带 secret 返回 200；9092 返回任意非 000 即活）；
- 协议是 **gRPC over h2c**，浏览器不能直连，用 99 的 `sing-box api ... --url http://<router>:9092 --secret <secret>`；
- 实测重启断流约 **1 秒**。

```bash
export BOX_API_URL=http://192.168.31.32:9092 BOX_API_SECRET='<secret>'
/usr/local/bin/sing-box api status && /usr/local/bin/sing-box api group list | head
```

### 6.5 路由配置通道（管理台「配置」tab 依赖）

**路由侧无需任何预装**：备份/校验/替换/重启/回滚全部由 99 的 vault-edit 通过 SSH 内联执行。

1. 99 侧放凭据（二选一）：

   - **页面方式（推荐，浏览器不保存）**：管理台 → 对应后端 → `配置` → `路由凭据` → 填用户名/口令 → `保存并读取配置`。口令写入 `/etc/vault-edit/routers.json`（0600），页面提交后立即清空；`GET /router/credentials` 只回显 user。
   - **手工方式**：

```bash
sudo install -d -m 0755 /etc/vault-edit
sudo tee /etc/vault-edit/routers.json >/dev/null <<'JSON'
{"192.168.31.32":{"name":"甲 32","user":"root","password":"<甲口令>"},
 "172.16.8.1":{"name":"乙 GL","user":"root","password":"<乙口令>"}}
JSON
sudo chmod 600 /etc/vault-edit/routers.json && sudo chown root:root /etc/vault-edit/routers.json
```

2. 验证：

```bash
curl -s -H "X-Vault-Key: $VAULT_KEY" 'localhost:9099/router/credentials'
curl -s -H "X-Vault-Key: $VAULT_KEY" 'localhost:9099/router/config?host=192.168.31.32' | head -c 120
curl -s -X POST -H "X-Vault-Key: $VAULT_KEY" -H 'Content-Type: application/json' \
     -d '{"host":"192.168.31.32"}' localhost:9099/router/restart   # 断流约 1–2s
```

3. 可选环境变量（99 的 `/etc/vault-edit.env`）：`ROUTERS_FILE`、`ROUTER_HOSTS`（白名单，逗号分隔）、`ROUTER_CONFIG`（默认 `/etc/sing-box/config.json`）、`ROUTER_SINGBOX`（默认 `/opt/sing-box/sing-box`）、`ROUTER_INIT`（默认 `/etc/init.d/sing-box`）。

## 7. 验证（发布后必跑）

```bash
VAULT_KEY='<clash_api secret>' scripts/check.sh
```

全绿清单：

- 管理台：`/health` 200、`/edit/` 200（LAN + EasyTier 两个入口）、`/rule-set/*.json` 200、Monaco loader 200、首页 `main-*.js` 200、`/publish` 无 key 401
- 公网：`/edit/` **404**、`/` 200、三个桶 `*.srs` 200
- 路由：`/proxies` 200（带 key），三来源预检均回 `Access-Control-Allow-Origin`，未知来源无
- NAS 挂载：`/Volumes/HddShare/WebEdit/rule-set` 可读

浏览器侧抽查（管理台 → 甲）：「概览」曲线有数据、「分组与节点」有 18 个组、「连接」有行、`🧩 规则编辑` 能打开 Monaco 且底部显示「✓ 合法 …」。

## 8. 升级流程

| 改了什么 | 跑什么 | 是否重启 |
|---|---|---|
| 前端页面/组件/样式 | `scripts/deploy_console.sh` | 否 |
| Go 服务/接口 | `scripts/deploy_service.sh` | 是（systemd 自动） |
| 规则桶内容 | 管理台「保存并发布」或 `scripts/publish.sh` | 否（路由 60s 自拉） |
| 路由 config（CORS/rule_set/节点） | 备份 → `sing-box check` → `/etc/init.d/sing-box restart` | 是（断网 2~5s） |
| Monaco 版本 | 改 `deploy_console.sh` 里的 `MONACO_VERSION` 后重跑 | 否 |

## 9. 回滚

| 层 | 操作 |
|---|---|
| 前端 | `sudo cp -a /usr/local/share/vault-edit/edit.bak-<ts>/. /usr/local/share/vault-edit/edit/`（保留最近三个即可） |
| Monaco | `sudo mv /usr/local/share/vault-edit/static/monaco/vs.bak-<ts> /usr/local/share/vault-edit/static/monaco/vs`，并同步 `VERSION` 文件 |
| Go 服务 | `sudo cp /usr/local/bin/vault-edit.bak-<ts> /usr/local/bin/vault-edit && sudo systemctl restart vault-edit` |
| 路由配置 | `cp /etc/sing-box/config.json.bak-<ts>-before-* /etc/sing-box/config.json && /etc/init.d/sing-box restart` |
| 规则桶 | 管理台重新编辑并发布；或从 NAS 备份/Git 历史恢复 `.json` 后发布 |

## 10. FAQ / 已踩过的坑

1. **`/edit/` 白屏、控制台 404 `main-*.js`**：Angular 产物是带 hash 的多文件，只覆盖 `index.html` 会坏；必须整目录替换，且 Go 侧 `/edit/` 要「命中文件即发、否则回落 index.html」。
2. **Monaco 不出来**：`/static/monaco/vs` 没铺或只放了 `editor.main.js`；它需要整份 `min/vs`（含 `language/json/json.worker.js`）。
3. **后端页 401**：该后端没填密钥（顶部「发布密钥」也会兜底）。
4. **`Failed to fetch`**：CORS 白名单缺页面来源，或来源写成了网段。
5. **99 ping 不通 `10.1.1.x` 但 peer 表正常**：EasyTier 数据面被 32 的 Socat 转发毒化（`/etc/config/socat` 里 `备注11010` 的 `udp → tcp4`）——改成 `udp4` 并清 socat 进程后重启 easytier。
6. **规则不生效**：桶内容未变化（按 hash 判定不会重载）/ 未过 60s / NAS 写回失败；查路由日志 `update rule-set <桶>`。
7. **`sshpass` 连续握手被掐**：脚本统一「一次 scp 上传全部 + 单次 ssh 安装」，sudo 口令走 `0600` 临时文件喂 `sudo -S`，不要放 argv。

更多细节（桶清单、出站映射、路由版本、回滚表）见 [runbook.md](runbook.md)。