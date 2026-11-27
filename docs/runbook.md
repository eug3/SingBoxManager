# Runbook · SingBoxManager 运维手册

> 改任何现网东西前先读完本文。
> 本文主机名 / IP / 域名均为**示例占位**：`console.lan`（管理机）、`nas.lan`（NAS）、`router-a.lan` / `router-b.lan`（各路由）、`dash.lan:888`（NAS 上的看板入口）、`rules.example.com`（公网只读入口）。真实地址与凭据只在内部运维资料中维护。

## 1. 架构与地址

```
浏览器(LAN)
  │ http://console.lan:9099/edit/          管理台（编辑规则 + 看/切各路由）
  │   ├─ /rule-set/<桶>.{json,srs}          管理机服务端只读 NAS 共享（同源，无 CORS）
  │   └─ POST /publish                     管理机服务端校验→编译→写回 NAS
  │ http://console.lan:9099/  → 302 /edit/
  │ http://dash.lan:888/                   首页「桶状态」（脱敏；公网同目录可见）
  │ http://dash.lan:888/zashboard/         zashboard（浏览器直连各路由）
  ▼
管理机 console.lan (Debian)
  │ systemd vault-edit → Go :9099            页面 + 只读桶源 + 发布；X-Vault-Key 鉴权
  │ /etc/vault-edit.env(0600)                VAULT_KEY = 各路由 clash_api secret（不进仓库/二进制）
  │ /usr/local/share/vault-edit/edit/        管理台前端（Angular 产物；deploy_console.sh 部署，不重编 Go）
  │ /usr/local/share/vault-edit/static/      静态资源（Monaco min/vs，走 /static/）
  │ /usr/local/bin/sing-box                  编译器
  │ SMB2 直连 //nas.lan/<share>（默认，纯 Go 无需挂载；local 模式=本地目录/cifs）
  ▼
NAS nas.lan
  │ <规则共享目录>/index.html                 首页（脱敏）
  │ <规则共享目录>/rule-set/*.json+*.srs+manifest.json
  │ 同目录服务: :888(内网直连) 与 rules.example.com(公网，经隧道/CDN 回源)
  ▼
路由 A router-a.lan / 路由 B router-b.lan …（可继续扩展）
  └ sing-box remote rule-set, update_interval=1m, cache_file 兜底
```

- **分工**：公网页面只负责「取规则」；**管理（改规则 / 看节点 / 切节点）一律走管理机的内网地址**。管理台目录已移出公网共享目录，公网 `/edit/` 与内网 `888/edit/` 均 404。
- **clash_api 由浏览器直连**：所以每台被查看的路由，其 `access_control_allow_origin` 必须含本页来源。页面有两个访问入口，各路由都已放行这三个来源：
  `http://dash.lan:888`（zashboard 老来源）、`http://console.lan:9099`（LAN 入口）、`http://console-vpn.lan:9099`（虚拟内网入口）。各路由实测预检均回 ACAO、未知来源无 ACAO。
- **后端可自定义**：管理台「＋ 添加后端」可加任意 clash_api（名称 / url / 密钥，存本浏览器 localStorage，支持逐个删除）；留空密钥则回退用顶部「发布密钥」。新加的后端同样要满足上一条 CORS 白名单（**origin 必须写精确的 `协议://主机:端口`，不能写网段**）。
  **草稿语义**：新加后端先是内存草稿（标签带 `✎`），地址没填/没点「保存」就不会落 localStorage——刷新或关页即消失；点保存时强制校验地址必须是 `http(s)://…`；载入时会自动丢弃历史遗留的空地址条目。
  **布局是两层横向 tab + 固定表头**：整页 `height:100dvh`、`body` 不滚动（`app-root` 撑满视口并 `overflow:hidden`，`body` 加 `overscroll-behavior:none` 防橡皮筋拖动）；顶栏（标题/发布密钥）+ 主 tab + 后端头部（状态条/POST 配置/子 tab）固定不动，只有 tab 下方内容区带独立滚动条（`.content` 负责规则编辑页，`.bp-body` 负责后端各子页）；滚动容器都用 `scrollbar-gutter:stable`，滚动条出现/消失不会挤动布局；页面最底部是一条**固定信息条**（`.foot`，不随内容滚动）显示管理台版本、当前生效后端的 sing-box 版本、发布链路与两个入口。主 tab = 各后端 + 「＋ 添加后端」+「🧩 规则编辑」；后端内子 tab = **概览 / 分组与节点 / 连接 / 日志 / 规则**（默认落在「概览」；切走子 tab 会断开对应 WS）。顶部「发布密钥」= 服务端 `X-Vault-Key`，与各后端密钥相互独立；密钥或后端地址一改会自动重新拉取数据。
  - **概览**（参考 zashboard 概览页，2026-11-21 加）：① 速率面板（下载/上传双线面积图，**每 2 秒一格、固定格数**（10 分钟=300 格，数据靠右推进、满窗后左移）；**高度按手填带宽满量程计算**，默认 1000 Mib/s（千兆，1 Mib=2²⁰ bit），输入框可改并持久化在本浏览器 localStorage（`rateBandwidthMib`），另有「固定满量程/自动」切换；标题显示 Mib/s 与**占带宽百分比**；默认显示**近 10 分钟**、可切 1/5/10 分，数据来自 `ws /traffic` 的 `{up,down}` 字节率 + `/connections` 的累计总量）② 连接数面积图（`ws /connections` 快照条数）③ 内存使用（`ws /memory` 的 `inuse`）④ 网络信息（后端地址、页面来源、运行模式 Rule/Global/Direct + **模式切换按钮**——sing-box 唯一可写的运行时字段 `PATCH /configs`、活跃连接、累计流量）⑤ 分组延时速览（各 Selector/URLTest 组当前节点 + 红黄绿延时 + 成员数，5s 自动刷新，可「全部测速」）。图表是自绘 SVG 面积图（无图表库、零外部依赖）。
  - 分组与节点：节点 chip 带**红黄绿延时**（阈值照 zashboard 默认 `<400ms 绿 / <800ms 黄 / ≥800ms 红`，失败红 ✗），Selector 组可点切换、**URLTest 组只读**（sing-box `PUT /proxies` 只接受 Selector）；「全部测速」并发 6 个 `/proxies/{名}/delay` 回填颜色。
  - 连接：3s 自动刷新（可关）、过滤框，链渲染成**标签链**（首跳绿色）、规则渲染成紫色标签，支持单条/全部断开。
  - 日志：进入 tab 才建立 `ws://<host>/logs?token=<key>&level=<级别>`，可切级别/暂停/清空，留最近 300 行。
  - 规则：进入 tab 才拉 `GET /rules`（#/类型标签/条件 payload/动作）。
  - 规则编辑：**Monaco 编辑器**（JSON 语法高亮 + 行号 + 括号匹配，来自本站 `/static/monaco/vs`，不依赖 CDN），下方实时前端校验（version/rules 结构、每条的键白名单），「保存并发布」走 `POST /publish` 并回报 sha256。
  - 前端栈：**Angular 22.3 + TypeScript 6 + signals + zoneless**（`web/console/`，无 zone.js），构建 `npx ng build --base-href=/edit/`，产物是带 hash 的多文件。
- 公网侧：`https://rules.example.com/` 与内网 `:888` 同目录，只有首页 + rule-set + zashboard；此前台页面不含密钥，密钥由用户手填 + localStorage。
- 公网链路（隧道/CDN）的访问凭据存 NAS 凭据目录（不入库）。

## 2. 桶清单（按路由匹配顺序，改前必读）

| # | 桶 | 出站 | 规则数 | 说明 |
|---|---|---|---|---|
| 005 | rs-node | 🚀 节点选择 | 13 | 头部定制域 |
| 006 | rs-direct | DIRECT | 17 | 直连域 |
| 007 | rs-fcm | 📢 谷歌FCM | 5 | |
| 008 | rs-custom | 🚀 定制 | 12 | |
| 009 | rs-openai | OpenAi | 9 | |
| 011 | rs-custom-2 | 🚀 定制 | 1 | 影子位（googleapis 在 bard 之后才轮到它） |
| 014 | bard | Bard | 1 | bard-domains，googleapis→Bard |
| 019 | rs-balance | BALANCE | 1 | |
| 026 | rs-openai-2 | OpenAi | 1 | 影子位（googleapis keyword，必须留在 bard 后） |
| 030 | rs-iplc | iplc-ss | 1 | youtube 上传走 IPLC |
| 033 | rs-custom-3 | 🚀 定制 | 1 | 影子位 |
| 036 | rs-fish | 🐟 漏网之鱼 | 1 | pythonhosted |
| 061-065 | rs-node-2 / rs-direct-2 / rs-gdirect | — | — | cn_ip/hk_ip 在 064/065（本地 srs，不在 NAS） |
| 073 | rs-block | 🛑 全球拦截 | 2 | 广告拦截 |
| 075 | rs-purify | 🍃 应用净化 | 8 | |
| 083+ | rs-direct-3 / rs-msft / rs-apple / rs-tg | — | — | |
| 094 | rs-media | 🌍 国外媒体 | 58 | |
| 152 | rs-node-3 | 🚀 节点选择 | 14 | github 大清单等 |
| 175 | rs-gdirect-2 | 🎯 全球直连 | 7 | 尾部大清单 |

**语义模型**：路由规则 = 35/37 条按序求值；桶内条目是「或」关系；域名靠 SNI 嗅探、IP 靠解析后地址，整桶任一维度命中即命中。**影子桶是在原位保序的安全合并产物**——把某桶的条目挪到别桶会改变顺序语义，必须重新做等价验证（历史教训见 §5）。

## 3. 日常操作

### 改分流（标准流程）
1. 打开 `http://console.lan:9099/edit/` → 右上角填访问密钥（= Clash API secret，存 localStorage）→ 选桶 → 改 JSON → 「保存并发布」
   或 CLI：`VAULT_KEY=xxx scripts/publish.sh rs-tg path/to/rs-tg.json`
2. 等 ≤60s（各路由日志出现 `updated rule-set <桶>`）
3. 验证：编辑台「重新拉取确认」/ zashboard 连接表看目标域名 `rule=rule_set=<桶>` / `scripts/check.sh`

### 切节点 / 看状态
- 管理台各后端 tab（浏览器直连路由 9090，需先填密钥；「＋ 添加后端」可加任意 clash_api）；
- 或 zashboard：`http://dash.lan:888/zashboard/`，后端 `router-a.lan:9090`、`router-b.lan:9090`

### 页面/服务发版
- `scripts/deploy_console.sh`（**前端，日常改页面只跑这个**）：`ng build --base-href=/edit/` → 内联 tar 上传 → 备份旧 `edit.bak-<ts>` 后整体替换 pageDir，并（首次或版本变化时）把 Monaco `min/vs` 铺到 `/usr/local/share/vault-edit/static/monaco/`；**不需要重启 Go 服务**。首次部署需能访问 npm registry（之后走 `/tmp/monaco-pack` 缓存）。
  - **在 macOS 上要加 `LC_ALL=C LANG=C` 前缀**：`LC_ALL=C LANG=C ROUTER_PW='…' scripts/deploy_console.sh`。不加的话在 UTF-8 语言环境下脚本会于第 2 步中止（见坑 17）；中止发生在上传之前，线上不受影响。
  - 备份目录名里的时间戳是**管理机自己的时区（EDT，比本地慢 12 小时）**，挑备份回滚时别当成「很久以前的」。
- 发前端前可先在本地验收：`node scripts/mock_clash.mjs` 起一个假 clash_api（420 条连接，含自然下线与僵死样本）并托管 ng 产物，打开 `http://127.0.0.1:8080/`、后端地址填 `http://127.0.0.1:8080` 即可，不需要路由（见 `docs/plan-connections-browser.md`）。
- `scripts/deploy_service.sh`（**只发后端**）：交叉编译 Go + systemd unit + `/etc/vault-edit.env` + 重启；**不再上传页面**（页面归 deploy_console.sh）。
- `scripts/deploy_web.sh`：只发公网首页 `web/index.html` → NAS（注意 NAS nginx ~1min 句柄缓存）
- 旧单文件页面 `web/edit/index.html` 仅作回滚参考（回滚：`cp -a /usr/local/share/vault-edit/edit.bak-<ts>/. /usr/local/share/vault-edit/edit/`）

## 4. 路由器配置口径（各台）

- 各路由配置文件的缩进与行尾可能不同（例如一台 LF+2 空格、另一台 CRLF+1 空格）——本地改配置必须保格式，`sing-box check` → 带日期备份 → 替换 → restart
- 备份（各自机器 /etc/sing-box/，命名规则）：`bak-<日期>-before-bulk-remotes`（全量托管前）、`bak-<日期>-before-cors`（加看板来源前）、`bak-<日期>-before-99origin`（加管理机 LAN 来源前）、`config.json.bak-<日期时间>-before-easytier-origin`（加虚拟内网来源前）
- clash_api CORS：各台均 `access_control_allow_origin:["http://dash.lan:888","http://console.lan:9099","http://console-vpn.lan:9099"]` + `access_control_allow_private_network:true`
- 登录口令：**不写在这里**，见 §6 的权威登记表
- 本地保留（不在 NAS 桶）：sniff/hijack-dns/clash_mode/port/ip_is_private、cn_ip/hk_ip（本地 srs）、各家自有 IP 段/自签域名/dns-in 等本地特有项

## 4.5 API service（2026-11-21 启用，各路由）

sing-box 1.15 `services[]` 里的 `type: "api"` 服务，与 Clash API 并存、互不影响。

| 项 | 值 |
|---|---|
| 端口 | **9092**（9090 仍是 Clash API；若 9091 被占用，统一 9092） |
| 监听 | `0.0.0.0:9092`（仅内网） |
| 密钥 | 与 clash_api 同一个 secret（轮换时两处一起改） |
| CORS | 白名单同 clash_api；`access_control_allow_private_network: true` |
| 协议 | **gRPC over h2c**（`POST /sing_box.api.v1.API/Status` 回 200），不是 REST —— 浏览器不能直连，须经管理机上的 `sing-box api` CLI 或由服务端代理 |

能力（`sing-box api --help`）：`status`（运行时长/内存/连接数/上下行速率）、`version`、`outbounds`、`group list|show|select|urltest`、`connection list|show|close`、`logs`、`mode list|set`、`networkquality`、`stun`、`tailscale`/`usbip`/`openvpn`/`openconnect`。**依然没有 reload / 写配置能力。**

验证（管理机上）：

```bash
export BOX_API_URL=http://router-a.lan:9092 BOX_API_SECRET='<secret>'
/usr/local/bin/sing-box api status
BOX_API_URL=http://router-b.lan:9092 /usr/local/bin/sing-box api group list | head -4
```

启用/回滚（每台重启一次，实测断流约 1s）：

```sh
cp -p /etc/sing-box/config.json /etc/sing-box/config.json.bak-$(date +%Y%m%d-%H%M%S)-before-api
# 末尾追加 services 段（保持原缩进/行尾）
/opt/sing-box/sing-box check -c /tmp/config.json.new
cp /tmp/config.json.new /etc/sing-box/config.json && /etc/init.d/sing-box restart
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <secret>' http://127.0.0.1:9090/version  # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9092/                                          # 404=活
```

回滚：`cp -p /etc/sing-box/config.json.bak-<ts>-before-api /etc/sing-box/config.json && /etc/init.d/sing-box restart`。各台启用前的备份名带 `-before-api` 后缀（时间戳在各自机器上）。

## 4.6 路由配置通道（2026-11-21 上线，管理台「配置」tab）

sing-box 没有 reload/写配置 API，所以「改节点配置 → 生效」由管理机的服务编排完成：

```
浏览器（管理台「配置」tab，X-Vault-Key）
   → 管理机 vault-edit  /router/{config,check,apply,restart,credentials}
   → SSH（凭据只存管理机的 /etc/vault-edit/routers.json，0600 root，host 白名单）
   → 路由上执行内联脚本（sh -s）+ 上传候选配置到 /tmp：
       ├ config    cat /etc/sing-box/config.json
       ├ check     上传 /tmp/vault-check-*.json → /opt/sing-box/sing-box check → 清理
       ├ apply     校验 sha(expectSha) → 上传 /tmp/vault-apply-*.json → check
       │           → 备份 config.json.bak-<ts>-before-apply → 原子替换 → restart
       │           → 健康检查（新 pid + :9090 监听）→ 失败自动回滚并重启旧配置
       └ restart   仅重启 + 健康检查
```

要点：
- **路由上不需要预装任何脚本**（早期版本的 `/usr/local/sbin/singbox-apply` 已废弃并清理）；用到的都是路由既有命令：`/opt/sing-box/sing-box`、`/etc/init.d/sing-box`、`netstat`、`sha256sum`、`cp/mv`。可用环境变量覆盖：`ROUTER_CONFIG` / `ROUTER_SINGBOX` / `ROUTER_INIT`。
- **鉴权口径**：`/router/*` 接口接受两种密钥 —— 管理机的 `VAULT_KEY`，**或**该路由 `clash_api` 认可的任何 secret（服务端会拿它去请求路由 `/version` 验证，200 即通过）。所以页面只需要你本来就要填的 **clash 密钥**（顶部“发布密钥”输入框可留空/同值）；`/publish` 仍只认 `VAULT_KEY`。
- **两套凭据要分清**：密钥 = clash secret（管理机鉴权 + 页面直连路由都用它）；**路由 SSH 用户名/口令**只存在管理机的 `/etc/vault-edit/routers.json`（0600 root），浏览器不保存。**打开「配置」时若连不上（缺发布密钥 / 缺 SSH 凭据 / 密钥错 / SSH 失败），会直接弹「连接 <host>」页**：填发布密钥 + SSH 用户名 + 口令 → `连接` → 成功即进入可编辑视图并把发布密钥写进 localStorage（口令不落地）。也可随时点 `路由凭据` 更新。
- **并发保护**：apply 带 `expectSha`，配置被别人改过返回 **409 STALE**；内容没变返回 `NO_CHANGE`（不重启）。
- **实测**：apply 约 1.3s、restart 约 1.1–2.4s，`downtime_s=1~2`。
- **凭据接口**：`GET/POST/DELETE /router/credentials`；host 必须在 `ROUTER_HOSTS` 白名单（默认各路由）。

## 5. 坑（都是踩过的）

1. **纯 ip_cidr 规则的顺序敏感性**：桶合并时只测域名会漏 IP 语义（曾把 telegram IP 段前移抢了 rs-tg 的活）；改桶结构要跑域名+IP 双维等价验证
2. **只 touch 不换内容 → 路由不重拉**（按 hash 判定）；重编译必然换内容 ✓
3. NAS nginx 文件句柄缓存：发布后 0-60s 内 URL 可能返回旧文件；CDN 侧 DYNAMIC 不缓存
4. `.srs` 经 ssh 传输按 magic `SRS\x01` 截取；`rule-set compile` 源是位置参数；`rule-set match` 退出码恒 0 看 stdout
5. 部分路由的 mixed-in 连接不进 Clash API /connections；路由自身 TCP 不进自家 TUN（iif lo 旁路）
6. Mac 挂 NAS：macOS 自动挂载共享目录；手动 mount_smbfs 报 File exists 时直接用已有挂载点
7. 管理机的 sudo 需密码（`echo pw | sudo -S`）；服务二进制放 /usr/local/bin（源码在 SingBoxManager/service，Go）
8. **管理机 → 某些路由依赖虚拟内网（如 EasyTier）数据面**：虚拟内网一坏这条路就死。修好（见坑 12）后即恢复可达——「管理机到不了某路由」只成立于虚拟内网故障期，别再当成拓扑结论。
9. **页面来源必须与路由 CORS 白名单一致**：页面换端口/换 IP 就要同步加白名单，否则浏览器侧直接被拦（服务端探活仍 200，容易误判）
10. **sshpass 连续多次握手会被管理机的 sshd 掐断**（`Connection closed`）；管理机已可从开发机公钥登录（`BatchMode=yes` 可用），脚本应优先公钥 + 只把口令用于 sudo
11. rule-set `.json` 源公网可下载：是否收口待拍板（§7）
12. **某路由的 Socat 端口转发会毒死虚拟内网（2026-11-21 二次复发）**：LuCI/Socat 里的转发若把 `proto udp` 写成 `dest_proto tcp4`，会把虚拟内网的 UDP 握手扭成 TCP，且对每个入向 UDP 包 fork 一个 socat 子进程（实测堆到上千个 socat），管理机的虚拟内网控制面还在、数据面全死。修法：`uci set socat.<id>.dest_proto='udp4' && uci commit socat` → `/etc/init.d/socat stop; killall -9 socat; /etc/init.d/socat start` → 再 `systemctl restart easytier`（管理机）。修完 socat 进程数回落、peer 全 p2p 0% 丢包，原「死路」恢复可达。
13. **Angular 产物是带 hash 的多文件 + `base-href=/edit/`**：不能只覆盖 `index.html`（`deploy_console.sh` 先备份整目录再整体替换）；Go 侧 `/edit/` 必须「命中文件就发文件、否则回落到 index.html」，只发 index.html 会让 `main-*.js` 404
14. **Monaco 走本站 `/static/monaco/vs`（AMD loader）**，不依赖 CDN；它需要 worker（`language/json/json.worker.js`），所以静态目录必须整份 `min/vs` 而不是只放 `editor.main.js`
15. **表单控件的坑**：`<select [value]>` 在选项是 `@for` 动态渲染时可能显示成第一个选项（值其实是对的）——用 `<option [selected]="…">` 绑定，`deploy_console.sh` 之后实测 `rs-tg` 显示正确
16. **CORS origin 只能写精确来源**：`access_control_allow_origin` 不接受网段，写 `协议://主机:端口`；页面换入口要同步所有路由
17. **`deploy_console.sh` 在 macOS 自带 `/bin/bash 3.2` + UTF-8 语言环境下必中止**：报 `scripts/deploy_console.sh: line 31: MONACO_VERSION…: unbound variable`。根因是脚本开了 `set -u`，而第 31 行 `（$MONACO_VERSION）` 里变量名紧贴全角括号——bash 3.2 在 UTF-8 locale 下会把「）」的首字节吸进变量名，于是去找一个不存在的变量；`LC_ALL=C` 下正常。agent / cron 常注入 `LANG=C.UTF-8`，所以在这些环境里必现，交互终端里则不一定。**规避**：运行时加 `LC_ALL=C LANG=C`（脚本只处理 ASCII，C locale 不影响中文输出与校验）。根治是把 `$MONACO_VERSION` 写成 `${MONACO_VERSION}`（一行），属发布链脚本改动，待拍板后再改。
18. **`sshpass` 打 OpenWrt 主路由（192.168.31.32）会偶发 `Permission denied`**：同一口令连续成功几次后，下一次可能被拒（2026-11-23 两次），而路由器那边 bearDropper 在给失败计数（阈值 5 次/12h，只挂 WAN 链，局域网来源不会被封）。改走 OpenSSH 的 askpass、一次连接只提交一次口令即稳定：`SSH_ASKPASS_REQUIRE=force SSH_ASKPASS=<只读助手脚本> ssh …`，口令只经环境变量传入、不落盘。判断某来源是否被封，用 `ssh-keyscan -T 5 <host>` 看 22 端口能否握手（被封则超时），不要再用口令去试。
20. **影子桶（shadow bucket）只在原位保序合并，不能搬位置**：`rs-custom-2 / rs-openai-2 / rs-custom-3`
    这类桶里只有一两条与主桶重复的条目，作用是让「按关键字命中的域名」在**特定顺序点位**被截住
    （例如 googleapis 必须先落到 bard、youtube 上传必须走 IPLC）。把影子桶的条目并回主桶、或把影子桶
    挪到别的位置，都会改变按序求值语义 —— 与坑 1 是同一类问题（见 §2 的桶表与「影子位」标注）。
    改桶结构必须重跑域名+IP 双维等价验证。

19. **sing-box 被内核 OOM 杀掉后 procd 不会自己再拉起**：`procd_set_param respawn` 只在进程「异常退出后的等待期」内生效，一旦有人显式 `stop` 或崩溃循环超过 procd 的耐心，实例就停在 `running:false`（`ubus call service list '{"name":"sing-box"}'` 可见 `exit_code:137`），路由会悄悄裸奔。查法 `logread | grep -i "Out of memory\|crash loop"`。**现场很容易丢**：主路由 `logd` 只留 64K（约 14 行/秒 → 20 秒），内核环形缓冲也会被覆盖——要复盘就在故障当下 `logread -f` 抓走，或调大 `logd -S`。

## 6. 凭据指路（仓库与页面不落密钥）

- Clash API 密钥（= vault-edit 的 X-Vault-Key）：各路由 `/etc/sing-box/config.json` 的 `experimental.clash_api.secret`；管理机侧只存在 `/etc/vault-edit.env`(0600)
- 路由 root / 管理机等口令：权威登记表在 NAS 的内部凭据目录（路径见内部运维资料，不入库）
- 公网隧道/CDN 的访问 token：同样在 NAS 凭据目录
- 历史提醒：**旧 key 曾以明文进入公开仓库的提交历史**，仍在等待轮换（见 §7）

## 7. 待办 / 可选方向

- [x] ~~各路由放行页面来源~~（2026-11-21 完成：管理机 LAN 来源 + 虚拟内网来源，均 `sing-box check` 后重启，实测 ACAO 正常）
- [ ] **轮换 clash secret / X-Vault-Key**：旧 key 已在公开仓库历史里；轮换顺序=改各路由 `clash_api.secret` → 改管理机 `/etc/vault-edit.env` → 重启 vault-edit → 各路由重启 sing-box → 页面重填密钥
- [ ] rule-set `.json` 源 + manifest.json 公网可下载的收口（移出共享目录或接受现状）
- [ ] clash-api 9090 监听 0.0.0.0 的安全面收窄（长期待办）
- [ ] 主路由 dns 收口漂移修复（uci list server + noresolv）
- [ ] cn.srs/geoip-hk.srs 转 remote + 定期更新

## 8. 回滚速查（命名规则）

| 改动 | 回滚 |
|---|---|
| 管理台目录移出公网 | 从 NAS 备份目录移回，并恢复看板来源的 CORS |
| 管理机服务/页面新版 | 管理机上 `/usr/local/bin/vault-edit.bak-<时间戳>`（每次部署自动留）；页面副本见 git |
| 管理台页面（`/edit/`）新版 | 管理机上 `cp -a /usr/local/share/vault-edit/edit.bak-<ts>/. /usr/local/share/vault-edit/edit/`（`deploy_console.sh` 每次自动留整目录；纯静态，**不用重启**；`<ts>` 是管理机 EDT 时区）。例：连接页改版前的版本在 `edit.bak-20261123-005236` |
| 某路由加管理机 LAN 来源 | `cp /etc/sing-box/config.json.bak-<日期>-before-99origin /etc/sing-box/config.json && /etc/init.d/sing-box restart` |
| 某路由加虚拟内网来源 | `cp config.json.bak-<日期时间>-before-easytier-origin …` → `/etc/init.d/sing-box restart` |
| Socat udp 转发修正 | `cp /etc/config/socat.bak-<日期>-before-udpfix /etc/config/socat && /etc/init.d/socat restart` |