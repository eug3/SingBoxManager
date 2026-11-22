# 部署手册（vault-edit + 管理台 + 路由侧）

> 目标读者：拿到开发机与内网权限的人。所有命令都在**本仓库根目录**执行。
> 密钥只走环境变量，**任何一步都不要把口令写进仓库文件**。
>
> 本文主机名 / IP / 域名均为**示例占位**：`console.lan`（管理机）、`nas.lan`（NAS）、`router-a.lan` / `router-b.lan`（各路由）、`dash.lan:888`（NAS 上的看板入口）、`rules.example.com`（规则路径）。真实地址只记录在内部运维资料，不进本仓库。

## 0. 拓扑与角色

| 角色 | 机器 | 说明 |
|---|---|---|
| 控制台/写通道 | 管理机 `console.lan`（Debian） | `vault-edit` Go 服务（`:9099`，systemd）；挂载 NAS 到 `/mnt/hdd`；带 `sing-box` 编译器 |
| 规则仓库 | NAS `nas.lan` 的 `<规则共享目录>` | `rule-set/*.json|*.srs`、`index.html`（公网首页）、`zashboard/` |
| 路由 A | `router-a.lan` | sing-box 1.15，TUN 分流，remote rule-set 每 60s 拉取 |
| 路由 B（可继续扩展） | `router-b.lan` … | 同上；新路由配置同一批 rule-set URL 即可接入 |
| 开发机 | Mac / Linux | `go` / `node` / `sshpass` / `npm` |

部署只有三个「可独立发版」的单元：**后端（Go）**、**前端（Angular）**、**公网首页（NAS 静态）**；路由侧只是配置项。

## 1. 前置检查

```bash
go version      # ≥ 1.27（service/go.mod 锁 1.27.4）
node -v         # ≥ 24（Angular 22 构建）
npm -v
which sshpass
```

管理机需要：可用 sudo、`/mnt/hdd` 已挂 NAS、`/usr/local/bin/sing-box` 可执行：

```bash
ssh <user>@console.lan
sudo -n true && echo sudo-ok
mount | grep /mnt/hdd          # 应为 cifs 挂载
/usr/local/bin/sing-box version | head -1
sudo systemctl status vault-edit --no-pager
```

## 2. 管理机一次性初始化（新机器才会用到）

> 已有机器跳过；`deploy_service.sh` 会自动创建目录、写 env、装 unit。

```bash
# 2.1 目录
sudo install -d -m 0755 /usr/local/share/vault-edit/edit /usr/local/share/vault-edit/static

# 2.2 密钥（0600，只有 root 可读；服务通过 systemd EnvironmentFile 注入）
sudo sh -c 'printf "VAULT_KEY=%s\n" "<clash_api secret>" > /etc/vault-edit.env'
sudo chmod 600 /etc/vault-edit.env

# 2.3 NAS 挂载（fstab 持久；guest 只读+写目录）
#    //<nas-host>/<share> /mnt/hdd cifs guest,uid=<user>,gid=users,iocharset=utf8,nofail 0 0

# 2.4 systemd：unit 随仓库 service/vault-edit.service 一起由 deploy_service.sh 安装
sudo systemctl enable --now vault-edit
sudo ss -ltnp | grep 9099
```

服务端可配置的环境变量（`Environment=`/`EnvironmentFile=`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN` | `:9099` | 监听地址（只在内网暴露，别改成 `0.0.0.0` 供公网） |
| `SHARE_DIR` | `/mnt/hdd/WebEdit/rule-set` | rule-set 桶目录（NAS 挂载点下的路径） |
| `PAGE_DIR` | `/usr/local/share/vault-edit/edit` | Angular 前端产物目录 |
| `STATIC_DIR` | `/usr/local/share/vault-edit/static` | Monaco 等静态资源 |
| `SINGBOX` | `/usr/local/bin/sing-box` | 编译 `.srs` 用 |
| `VAULT_KEY` | **必填** | `X-Vault-Key` 校验；缺失服务拒绝启动 |

## 3. 发布后端（Go 服务）

```bash
export ROUTER_PW='<管理机 sudo 口令>'
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
export ROUTER_PW='<管理机 sudo 口令>'
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

注意：NAS 的 nginx 有约 1 分钟的句柄缓存，发布后可能短暂拿到旧页面；CDN 侧另有缓存，必要时 purge。

`<规则共享目录>` 现状：`index.html`（脱敏首页）+ `rule-set/`（桶）+ `zashboard/`（备选看板）。**管理台不在公网**，`https://rules.example.com/edit/` 应返回 404。

## 6. 路由侧配置（路由 A / 路由 B / …）

### 6.0 新路由一键安装 sing-box（OpenWrt）

新 OpenWrt 路由从零接入,在**开发机**上跑(路由上无需预装任何东西):

```bash
ROUTER=192.168.31.32 ROUTER_PW='<路由口令>' scripts/install_openwrt_singbox.sh
```

脚本做的事:探测 CPU 架构(x86_64/aarch64/armv7l → 官方 release 对应包)→ 本机下载
sing-box(`SINGBOX_VERSION` 控版本,默认最新稳定版 1.14.4,≤ 路由侧版本即可,`.srs` 向下
兼容;国内可 `GH_PROXY=` 走镜像)→ 装依赖 `kmod-tun` → 二进制装到 `/opt/sing-box/sing-box`
(旧版自动备份 `.bak-<ts>`)→ 写 procd init `/etc/init.d/sing-box` → 装初始配置(路由已有
config.json 则**不动**,新的留在 `config.json.new`)→ enable + restart + 自检(进程/版本/
`sing-box check`/clash_api 9090 监听/开机自启)。

装完的路径与 §6.5 管理机 `/router/*` 的默认完全一致(`ROUTER_SINGBOX`/`ROUTER_INIT`),
管理台「添加后端 + 配置 tab 填 SSH 凭据」即可接管。可选环境变量:`CONFIG_JSON=`(推
本地生产配置上去)、`RULES_BASE=`(内置模板的远程 rule-set 地址)、`PORT=`、`ROUTER_USER=`。

> 兜底模板只保证服务能起 + clash_api + 两个示例远程桶;secret 是占位符,务必按 §6.1/§6.2
> 换生产配置与 CORS 白名单后再切流量。升级同样跑这个脚本(`SINGBOX_VERSION=1.16.0` 之类),
> 配置不动、二进制自动备份。

### 6.1 remote rule-set 指向 NAS

各路由 `config.json` 的 `route.rule_set[]` 均为 `type: remote`、`format: binary`、`url: https://rules.example.com/rule-set/<桶>.srs`、`update_interval: 1m`。换域名/NAS 时改这里，**改完必须 `sing-box check` + 重启**。

### 6.2 页面来源白名单（CORS）

管理台浏览器直连 `clash_api`，所以每台路由都要放行页面来源：

```json
"access_control_allow_origin": ["http://dash.lan:888",
                                "http://console.lan:9099",
                                "http://console-vpn.lan:9099"],
"access_control_allow_private_network": true
```

改配置的标准动作（各台同）：

```bash
cp /etc/sing-box/config.json /etc/sing-box/config.json.bak-$(date +%Y%m%d-%H%M%S)-before-origin
# 编辑 access_control_allow_origin（注意各路由配置文件的缩进与行尾可能不同，别改格式）
/opt/sing-box/sing-box check -c /etc/sing-box/config.json
/etc/init.d/sing-box restart
```

> origin 必须是**精确的 `协议://主机:端口`**，写 `10.x.x.0/24` 这类网段无效。

### 6.3 验证 CORS

```bash
for R in router-a.lan router-b.lan; do
  for O in http://dash.lan:888 http://console.lan:9099 http://console-vpn.lan:9099 http://evil.example; do
    printf "%-16s %-28s ACAO=%s\n" "$R" "$O" \
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
    "access_control_allow_origin": ["http://dash.lan:888",
                                    "http://console.lan:9099",
                                    "http://console-vpn.lan:9099"],
    "access_control_allow_private_network": true }
]
```

- 端口避开占用项（若某台 9091 已被占用 → 统一 9092）；
- 追加时保持原缩进与行尾（不同路由的配置格式可能不同，别改格式）；
- 生效流程：`sing-box check` → 重启 → 双端口验证（9090 带 secret 返回 200；9092 返回任意非 000 即活）；
- 协议是 **gRPC over h2c**，浏览器不能直连，用管理机的 `sing-box api ... --url http://<router>:9092 --secret <secret>`；
- 实测重启断流约 **1 秒**。

```bash
export BOX_API_URL=http://router-a.lan:9092 BOX_API_SECRET='<secret>'
/usr/local/bin/sing-box api status && /usr/local/bin/sing-box api group list | head
```

### 6.5 路由配置通道（管理台「配置」tab 依赖）

**路由侧无需任何预装**：备份/校验/替换/重启/回滚全部由管理机的 vault-edit 通过 SSH 内联执行。

1. 管理机侧放凭据（二选一）：

   - **页面方式（推荐，浏览器不保存）**：管理台 → 对应后端 → `配置` → `路由凭据` → 填用户名/口令 → `保存并读取配置`。口令写入 `/etc/vault-edit/routers.json`（0600），页面提交后立即清空；`GET /router/credentials` 只回显 user。
   - **手工方式**：

```bash
sudo install -d -m 0755 /etc/vault-edit
sudo tee /etc/vault-edit/routers.json >/dev/null <<'JSON'
{"router-a.lan":{"name":"路由 A","user":"root","password":"<路由A口令>"},
 "router-b.lan":{"name":"路由 B","user":"root","password":"<路由B口令>"}}
JSON
sudo chmod 600 /etc/vault-edit/routers.json && sudo chown root:root /etc/vault-edit/routers.json
```

2. 鉴权说明：`/router/*` 接受 `VAULT_KEY` **或**路由 `clash_api` 认可的 secret（服务端向 `http://<route>:9090/version` 校验，200 即通过）；`/publish` 只认 `VAULT_KEY`。页面因此只需填 clash 密钥。

3. 验证：

```bash
curl -s -H "X-Vault-Key: $VAULT_KEY" 'localhost:9099/router/credentials'
curl -s -H "X-Vault-Key: $VAULT_KEY" 'localhost:9099/router/config?host=router-a.lan' | head -c 120
curl -s -X POST -H "X-Vault-Key: $VAULT_KEY" -H 'Content-Type: application/json' \
     -d '{"host":"router-a.lan"}' localhost:9099/router/restart   # 断流约 1–2s
```

4. 可选环境变量（管理机的 `/etc/vault-edit.env`）：`ROUTERS_FILE`、`ROUTER_HOSTS`（白名单，逗号分隔）、`ROUTER_CONFIG`（默认 `/etc/sing-box/config.json`）、`ROUTER_SINGBOX`（默认 `/opt/sing-box/sing-box`）、`ROUTER_INIT`（默认 `/etc/init.d/sing-box`）。

### 6.6 规则桶存储模式（2026-11-21 起默认纯 Go SMB2，不再需要 cifs 挂载）

`/etc/vault-edit.env` 可选变量：

```bash
SHARE_MODE=smb        # smb(默认) | sftp | local
SMB_ADDR=192.168.31.8:445
SMB_SHARE=HddShare
SMB_PATH=WebEdit/rule-set
SMB_USER=             # 留空=guest（NAS 共享是 sec=none 时无需账号）
SMB_PASS=
# SFTP 备用通道
SFTP_ADDR=nas.lan:22
SFTP_USER=
SFTP_PASS=            # 或 SFTP_KEY=/path/to/id_ed25519
SFTP_PATH=/volume1/WebEdit/rule-set
PUBLIC_BASE=https://rules.example.com   # 体检时拉取公网 URL 用
```

**只读文件端口（与曝光面隔离）**：`filesListen` 默认 `:9098`，只提供 `/rule-set/*` 与
`/health`；管理台仍在 `:9099`（`/edit`、`/router/*`、`/publish`）。要对外提供规则桶，
反代 `9098` 即可，**不要把 9099 暴露出去**。端口改完保存即时热重启监听，不用重启服务。

存储配置也可在管理台顶栏状态点后的 ⚙ 里改（保存即热生效），落盘 `/etc/vault-edit/share.json`（0600）。

**数据库**：状态都在 `/etc/vault-edit/sbm.db`（0600，SQLite/WAL）——存储配置、路由 SSH 凭据、
发布与配置应用记录。可用 `DB_FILE` 改位置；首次启动会自动迁移旧的 `share.json` / `routers.json`
（旧文件保留不动）。查看：`curl -s -H "X-Vault-Key: $VAULT_KEY" localhost:9099/db/info`。

**公网入口写进路由规则**：`GET /public/rules/preview?base=…` 预览会改多少条，
`POST /public/rules/apply {"base":…,"confirm":true}` 写入（会重启 sing-box，约 1s）。

体检（管理台顶栏状态点也用它）：

```bash
curl -s localhost:9099/share/health | python3 -m json.tool
```

旧行为（`SHARE_MODE=local` + 内核 cifs 挂载 `/mnt/hdd`）仍可用，但已不必要。

## 7. 验证（发布后必跑）

```bash
VAULT_KEY='<clash_api secret>' scripts/check.sh
```

全绿清单：

- 管理台：`/health` 200、`/edit/` 200（LAN + 虚拟内网两个入口）、`/rule-set/*.json` 200、Monaco loader 200、首页 `main-*.js` 200、`/publish` 无 key 401
- 公网：`/edit/` **404**、`/` 200、三个桶 `*.srs` 200
- 路由：`/proxies` 200（带 key），各页面来源预检均回 `Access-Control-Allow-Origin`，未知来源无
- NAS 挂载：管理机的 `SHARE_DIR` 可读

浏览器侧抽查（管理台 → 任一路由）：「概览」曲线有数据、「分组与节点」有组、「连接」有行、`🧩 规则编辑` 能打开 Monaco 且底部显示「✓ 合法 …」。

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
5. **管理机 ping 不通虚拟内网对端但 peer 表正常**：虚拟内网（如 EasyTier）数据面被中间转发（如 Socat 的 `udp → tcp4` 误配）毒化——改成 `udp4` 并清 socat 进程后重启虚拟内网服务。
6. **规则不生效**：桶内容未变化（按 hash 判定不会重载）/ 未过 60s / NAS 写回失败；查路由日志 `update rule-set <桶>`。
7. **`sshpass` 连续握手被掐**：脚本统一「一次 scp 上传全部 + 单次 ssh 安装」，sudo 口令走 `0600` 临时文件喂 `sudo -S`，不要放 argv。

更多细节（桶清单、出站映射、路由版本、回滚表）见 [runbook.md](runbook.md)。

## 11. Docker 部署（可选，与脚本裸机部署二选一）

> 仓库根目录的 `Dockerfile`（多阶段）+ `docker-compose.yml` + `.env.example` 把三个单元
> 打成**一个镜像**：Angular 管理台、Monaco 静态、Go 服务、`sing-box` 编译器（从 GitHub
> Releases 拉固定版本，`/publish` 编译 `.srs` 用，版本可钉死并与路由侧对齐）。
> 适合新机器快速拉起或不想在管理机铺 Go/Node 工具链的场景；日常改页面仍推荐
> `deploy_console.sh`（静态替换不重启）。

### 11.1 构建

```bash
# 构建上下文必须是仓库根目录
docker build -t sbm/vault-edit .
# 可覆盖参数：sing-box 版本（≤ 路由侧版本即可，.srs 向下兼容）、下载镜像、Monaco 版本
docker build --build-arg SINGBOX_VERSION=1.14.4 --build-arg MONACO_VERSION=0.57.0 \
             -t sbm/vault-edit .
# 国内网络拉 GitHub 困难时：--build-arg GH_PROXY=https://ghproxy.com
```

### 11.2 运行（compose）

```bash
cp .env.example .env     # 填 VAULT_KEY（必填）；存储默认 local，改 SMB/SFTP 见文件内注释
mkdir -p data/rule-set   # local 模式的规则桶目录（compose 已挂进容器）
docker compose up -d --build
```

- 管理台 `http://<主机>:9099/edit/`；只读规则源 `:9098`（只挂 `/rule-set/` 与 `/health`）
- 数据落在 named volume `vault-data`（SQLite / routers.json / share.json），重建容器不丢
- 密钥只经 `.env`（已 gitignore）注入容器，不进镜像、不进仓库——与 §2 的裸机口径一致

### 11.3 与脚本部署的对照

| 事项 | 脚本裸机（默认） | Docker |
|---|---|---|
| 后端发版 | `scripts/deploy_service.sh`（交叉编译 + scp + systemd） | `docker compose up -d --build`（整镜像重建） |
| 前端发版 | `scripts/deploy_console.sh`（静态替换，不重启） | 同上（镜像里前端与后端一起换） |
| sing-box 编译器 | 管理机 `/usr/local/bin/sing-box`（手动维护） | 镜像内置，`SINGBOX_VERSION` 构建参数控版本 |
| 数据/凭据 | `/etc/vault-edit*`（0600 root） | volume `vault-data` + `.env` |
| 回滚 | 备份目录/二进制（§9） | `docker tag` 留旧镜像或镜像 tag 固定版本号 |

### 11.4 坑

1. **`.srs` 兼容性**：编译器版本新于路由 sing-box 时可能产出路由加载不了的 rule-set——
   `SINGBOX_VERSION` 务必 ≤ 路由侧版本（路由为 1.15 内测线，镜像默认 1.14.4 稳定版，
   产物向下兼容）。官方 ghcr 镜像只有 `latest` 无法钉版本，所以 Dockerfile 改为从
   GitHub Releases 下载固定版本，注意两点：资产命名是连字符
   （`sing-box-1.14.4-linux-amd64-musl.tar.gz`）；**必须用 `-musl` 变体**（镜像运行时
   是 Alpine，官方默认构建链接 glibc，会报 `no such file or directory`）。
2. **CORS 白名单**：容器端口与裸机一致（9099/9098）时无需动路由配置；改端口则要同步
   路由 `access_control_allow_origin` 与 `service/config.go` 的 `allowOrigins`。
3. **local 模式公网入口**：容器默认 `SHARE_MODE=local`，公网只读要靠反代指到 `:9098`，
   并在管理台「⚙ 存储配置」里把 `PUBLIC_BASE` 改成对外地址。