# Runbook · SingBoxManager 运维手册

核验 2026-11-21。改任何现网东西前先读完本文。

## 1. 架构与地址

```
浏览器(LAN)
  │ http://192.168.31.99:9099/edit/        管理台（编辑规则 + 看/切两台路由）
  │   ├─ /rule-set/<桶>.{json,srs}          99 服务端只读 NAS 共享（同源，无 CORS）
  │   └─ POST /publish                     99 服务端校验→编译→写回 NAS
  │ http://192.168.31.99:9099/  → 302 /edit/
  │ http://192.168.31.8:888/               首页「桶状态」（脱敏；公网同目录可见）
  │ http://192.168.31.8:888/zashboard/     zashboard v3.30.0（浏览器直连两台路由）
  ▼
99号机 debain-99 (192.168.31.99)
  │ systemd vault-edit → Go :9099            页面 + 只读桶源 + 发布；X-Vault-Key 鉴权
  │ /etc/vault-edit.env(0600)                VAULT_KEY = 两台路由 clash_api secret（不进仓库/二进制）
  │ /usr/local/share/vault-edit/edit/        管理台前端（Angular 产物；deploy_console.sh 部署，不重编 Go）
  │ /usr/local/share/vault-edit/static/      静态资源（Monaco min/vs，走 /static/）
  │ /usr/local/bin/sing-box                  编译器（自 32 拷贝，1.15.0-alpha.13）
  │ /mnt/hdd ← cifs guest → //192.168.31.8/HddShare   fstab 持久挂载
  ▼
NAS uc-nas (192.168.31.8)
  │ HddShare/WebEdit/index.html              首页（脱敏）
  │ HddShare/WebEdit/rule-set/*.json+*.srs+manifest.json
  │ 同目录服务: :888(内网直连) 与 router.guaishoudejia.com(CF橙云→home隧道→DSM vhost)
  ▼
路由甲 192.168.31.32 / 路由乙 172.16.8.1
  └ sing-box remote rule-set, update_interval=1m, cache_file 兜底
```

- **分工（2026-11-21 拍板）**：公网页面只负责「取规则」；**管理（改规则 / 看节点 / 切节点）一律走 99 的内网地址**。原 `WebEdit/edit/` 已移出公网目录（备份 `HddShare/_bak-WebEdit-edit-20261121/`），公网 `/edit/` 与内网 `888/edit/` 均 404。
- **clash_api 由浏览器直连**：所以每台被查看的路由，其 `access_control_allow_origin` 必须含本页来源。页面有两个访问入口，两台路由都已放行这三个来源：
  `http://192.168.31.8:888`（zashboard 老来源）、`http://192.168.31.99:9099`（LAN 入口）、`http://10.1.1.99:9099`（EasyTier 入口）。乙(2026-11-21 13:36) 已补齐，甲(13:35) 已补齐，两台实测预检均回 ACAO、未知来源无 ACAO。
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
- 公网侧：`https://router.guaishoudejia.com/` 与 888 同目录，只有首页 + rule-set + zashboard；此前台页面不含密钥，密钥由用户手填 + localStorage。
- CF 访问：`HddShare/credentials/cloudflare/cloudflare-r2.secret` 里的 `cfat_` token；home 隧道 35fed113（connector 在 97 号机）。

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
1. 打开 `http://192.168.31.99:9099/edit/` → 右上角填访问密钥（= Clash API secret，存 localStorage）→ 选桶 → 改 JSON → 「保存并发布」
   或 CLI：`VAULT_KEY=xxx scripts/publish.sh rs-tg path/to/rs-tg.json`
2. 等 ≤60s（两台日志各出现 `updated rule-set <桶>`）
3. 验证：编辑台「重新拉取确认」/ zashboard 连接表看目标域名 `rule=rule_set=<桶>` / `scripts/check.sh`

### 切节点 / 看状态
- 管理台各后端 tab（甲/乙/自建，浏览器直连路由 9090，需先填密钥；「＋ 添加后端」可加任意 clash_api）；
- 或 zashboard：`http://192.168.31.8:888/zashboard/`，后端 `192.168.31.32:9090`、`172.16.8.1:9090`

### 页面/服务发版
- `scripts/deploy_console.sh`（**前端，日常改页面只跑这个**）：`ng build --base-href=/edit/` → 内联 tar 上传 → 备份旧 `edit.bak-<ts>` 后整体替换 pageDir，并（首次或版本变化时）把 Monaco `min/vs` 铺到 `/usr/local/share/vault-edit/static/monaco/`；**不需要重启 Go 服务**。首次部署需能访问 npm registry（之后走 `/tmp/monaco-pack` 缓存）。
- `scripts/deploy_service.sh`（**只发后端**）：交叉编译 Go + systemd unit + `/etc/vault-edit.env` + 重启；**不再上传页面**（页面归 deploy_console.sh）。
- `scripts/deploy_web.sh`：只发公网首页 `web/index.html` → NAS（注意 NAS nginx ~1min 句柄缓存）
- 旧单文件页面 `web/edit/index.html` 仅作回滚参考（回滚：`cp -a /usr/local/share/vault-edit/edit.bak-<ts>/. /usr/local/share/vault-edit/edit/`）

## 4. 路由器配置口径（两台）

- GL(乙)：CRLF+1空格缩进；32(甲)：LF+2空格——本地改配置必须保格式，`sing-box check` → 带日期备份 → 替换 → restart
- 现役 sha256：甲 `1f4bf7cbb1550d6e…`（22,634B，2026-11-21 13:35 加 EasyTier 来源后）、乙 `cfe64cf283aee9ee…`（20,019B，2026-11-21 13:36 加 EasyTier 来源后）
- 备份（各自机器 /etc/sing-box/）：`bak-20261121-before-bulk-remotes`（全量托管前）、`bak-20261121-before-cors`（加 888 来源前）、`bak-20261121-before-99origin`（加 LAN 99 来源前）、`config.json.bak-20261121-133552/133603-before-easytier-origin`（甲/乙加 EasyTier 来源前）
- clash_api CORS：两台均 `access_control_allow_origin:["http://192.168.31.8:888","http://192.168.31.99:9099","http://10.1.1.99:9099"]` + `access_control_allow_private_network:true`
- 登录口令：**不写在这里**，见 §6 的权威登记表
- 本地保留（不在 NAS 桶）：sniff/hijack-dns/clash_mode/port/ip_is_private、cn_ip/hk_ip（本地 srs）、GL 的 43.154.0.0/16、32 的 43.154.68.117/32 + v.shayuqite.xyz + dns-in

## 4.5 API service（2026-11-21 启用，两台路由）

sing-box 1.15 `services[]` 里的 `type: "api"` 服务，与 Clash API 并存、互不影响。

| 项 | 值 |
|---|---|
| 端口 | **9092**（9090 仍是 Clash API；32 的 9091 被容器占用，故统一 9092） |
| 监听 | `0.0.0.0:9092`（仅内网） |
| 密钥 | 与 clash_api 同一个 secret（轮换时两处一起改） |
| CORS | 白名单同 clash_api；`access_control_allow_private_network: true` |
| 协议 | **gRPC over h2c**（`POST /sing_box.api.v1.API/Status` 回 200），不是 REST —— 浏览器不能直连，须经 99 上的 `sing-box api` CLI 或由服务端代理 |

能力（`sing-box api --help`）：`status`（运行时长/内存/连接数/上下行速率）、`version`、`outbounds`、`group list|show|select|urltest`、`connection list|show|close`、`logs`、`mode list|set`、`networkquality`、`stun`、`tailscale`/`usbip`/`openvpn`/`openconnect`。**依然没有 reload / 写配置能力。**

验证（99 上）：

```bash
export BOX_API_URL=http://192.168.31.32:9092 BOX_API_SECRET='<secret>'
/usr/local/bin/sing-box api status
BOX_API_URL=http://172.16.8.1:9092 /usr/local/bin/sing-box api group list | head -4   # 乙
```

启用/回滚（每台重启一次，实测断流约 1s）：

```sh
cp -p /etc/sing-box/config.json /etc/sing-box/config.json.bak-$(date +%Y%m%d-%H%M%S)-before-api
# 末尾追加 services 段（保持原缩进/行尾：32 为 2 空格+LF，GL 为 1 空格+CRLF）
/opt/sing-box/sing-box check -c /tmp/config.json.new
cp /tmp/config.json.new /etc/sing-box/config.json && /etc/init.d/sing-box restart
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <secret>' http://127.0.0.1:9090/version  # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9092/                                          # 404=活
```

回滚：`cp -p /etc/sing-box/config.json.bak-<ts>-before-api /etc/sing-box/config.json && /etc/init.d/sing-box restart`。
本轮备份：32 `config.json.bak-20261121-151649-before-api`，GL `config.json.bak-20261121-151719-before-api`。

## 4.6 路由配置通道（2026-11-21 上线，管理台「配置」tab）

sing-box 没有 reload/写配置 API，所以「改节点配置 → 生效」由 99 的服务编排完成：

```
浏览器（管理台「配置」tab，X-Vault-Key）
   → 99 vault-edit  /router/{config,check,apply,restart,credentials}
   → SSH（凭据只存 99 的 /etc/vault-edit/routers.json，0600 root，host 白名单）
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
- **鉴权口径**：`/router/*` 接口接受两种密钥 —— 99 的 `VAULT_KEY`，**或**该路由 `clash_api` 认可的任何 secret（服务端会拿它去请求路由 `/version` 验证，200 即通过）。所以页面只需要你本来就要填的 **clash 密钥**（顶部“发布密钥”输入框可留空/同值）；`/publish` 仍只认 `VAULT_KEY`。
- **两套凭据要分清**：密钥 = clash secret（99 鉴权 + 页面直连路由都用它）；**路由 SSH 用户名/口令**只存在 99 的 `/etc/vault-edit/routers.json`（0600 root），浏览器不保存。**打开「配置」时若连不上（缺发布密钥 / 缺 SSH 凭据 / 密钥错 / SSH 失败），会直接弹「连接 <host>」页**：填发布密钥 + SSH 用户名 + 口令 → `连接` → 成功即进入可编辑视图并把发布密钥写进 localStorage（口令不落地）。也可随时点 `路由凭据` 更新。
- **并发保护**：apply 带 `expectSha`，配置被别人改过返回 **409 STALE**；内容没变返回 `NO_CHANGE`（不重启）。
- **实测**：apply 约 1.3s、restart 约 1.1–2.4s，`downtime_s=1~2`。
- **凭据接口**：`GET/POST/DELETE /router/credentials`；host 必须在 `ROUTER_HOSTS` 白名单（默认两台路由）。

## 5. 坑（都是踩过的）

1. **纯 ip_cidr 规则的顺序敏感性**：桶合并时只测域名会漏 IP 语义（曾把 telegram IP 段前移抢了 rs-tg 的活）；改桶结构要跑域名+IP 双维等价验证
2. **只 touch 不换内容 → 路由不重拉**（按 hash 判定）；重编译必然换内容 ✓
3. NAS nginx 文件句柄缓存：发布后 0-60s 内 URL 可能返回旧文件；CF 侧 DYNAMIC 不缓存
4. `.srs` 经 ssh 传输按 magic `SRS\x01` 截取；`rule-set compile` 源是位置参数；`rule-set match` 退出码恒 0 看 stdout
5. GL 的 mixed-in 连接不进 Clash API /connections；GL 自身 TCP 不进自家 TUN（iif lo 表 16800 旁路）
6. Mac 挂 NAS：macOS 自动挂 `/Volumes/HddShare`；手动 mount_smbfs 报 File exists 时直接用 /Volumes
7. 99 的 sudo 需密码（`echo pw | sudo -S`）；服务二进制放 /usr/local/bin（源码在 SingBoxManager/service，Go）
8. **99 → 172.16.8.1 依赖 EasyTier 数据面**：99 的 `172.16.8.0/24` 命中 tun0（metric 65535），EasyTier 数据面一坏这条路就死（2026-11-21 上午实测 000）。修好 EasyTier（见坑 12）后实测变 200——所以「99 到不了 GL」只成立于 EasyTier 故障期，别再当成拓扑结论。32 自己到 GL 走 pppoe-WAN 出公网，始终不通。
9. **页面来源必须与路由 CORS 白名单一致**：页面换端口/换 IP 就要同步加白名单，否则浏览器侧直接被拦（服务端探活仍 200，容易误判）
10. **sshpass 连续多次握手会被 99 的 sshd 掐断**（`Connection closed`）；99 已可从 Mac 公钥登录（`BatchMode=yes` 可用），脚本应优先公钥 + 只把口令用于 sudo
11. rule-set `.json` 源公网可下载：是否收口待拍板（§7）
12. **32 的 Socat 端口转发会毒死 EasyTier（2026-11-21 二次复发）**：LuCI/Socat 里两条 `备注11010` 的转发（`/etc/config/socat`，id `37b64b42…` tcp、`a8b20736…` udp）。其中 udp 那条被写成 `proto udp → dest_proto tcp4`，把 EasyTier 的 UDP 握手扭成 TCP，且对每个入向 UDP 包 fork 一个 socat 子进程——实测堆到 **1063 个 socat**，99 的 EasyTier 控制面还在、数据面全死（ping 任何对端全超时）。修法：`uci set socat.a8b207366a5748ba99dd3000a6f91832.dest_proto='udp4' && uci commit socat` → `/etc/init.d/socat stop; killall -9 socat; /etc/init.d/socat start` → 再 `systemctl restart easytier`（99）。修完 socat 1063→38，99 peer 全 p2p 0% 丢包，且 **99 到 172.16.8.1 从死路变成可达（200）**。
13. **Angular 产物是带 hash 的多文件 + `base-href=/edit/`**：不能只覆盖 `index.html`（`deploy_console.sh` 先备份整目录再整体替换）；Go 侧 `/edit/` 必须「命中文件就发文件、否则回落到 index.html」，只发 index.html 会让 `main-*.js` 404
14. **Monaco 走本站 `/static/monaco/vs`（AMD loader）**，不依赖 CDN；它需要 worker（`language/json/json.worker.js`），所以静态目录必须整份 `min/vs` 而不是只放 `editor.main.js`
15. **表单控件的坑**：`<select [value]>` 在选项是 `@for` 动态渲染时可能显示成第一个选项（值其实是对的）——用 `<option [selected]="…">` 绑定，`deploy_console.sh` 之后实测 `rs-tg` 显示正确
16. **CORS origin 只能写精确来源**：`access_control_allow_origin` 不接受 `10.1.1.0/24` 这类网段，写 `协议://主机:端口`；页面换入口要同步两台路由

## 6. 凭据指路（仓库与页面不落密钥）

- Clash API 密钥（= vault-edit 的 X-Vault-Key）：两台 `/etc/sing-box/config.json` 的 `experimental.clash_api.secret`；99 侧只存在 `/etc/vault-edit.env`(0600)
- 路由 root / 99号机等口令：权威登记表 `\\192.168.31.8\HddShare\credentials\dev-and-test-password.txt`
- Cloudflare：`HddShare/credentials/cloudflare/cloudflare-r2.secret`
- 历史提醒：**旧 key 曾以明文进入公开仓库 `eug3/SingBoxManager` 的提交历史**（值见两台路由 config / 99 的 env），仍在等待轮换（见 §7）

## 7. 待办 / 可选方向

- [x] ~~乙(GL) 放行页面来源~~（2026-11-21 13:36 完成：LAN 99 来源 + EasyTier 10.1.1.99 来源，均 `sing-box check` 后重启，实测 ACAO 正常）
- [ ] **轮换 clash secret / X-Vault-Key**：旧 key 已在公开仓库历史里；轮换顺序=改两台 `clash_api.secret` → 改 99 `/etc/vault-edit.env` → 重启 vault-edit → 两台重启 sing-box → 页面重填密钥
- [ ] rule-set `.json` 源 + manifest.json 公网可下载的收口（移出 WebEdit 或接受现状）
- [ ] clash-api 9090 监听 0.0.0.0 的安全面收窄（长期待办）
- [ ] 32 的 dns 收口漂移修复（uci list server + noresolv，见记忆卡）
- [ ] cn.srs/geoip-hk.srs 转 remote + 定期更新

## 8. 2026-11-21 这轮改动的回滚

| 改动 | 回滚 |
|---|---|
| NAS `WebEdit/edit/` 移出公网 | `mv /Volumes/HddShare/_bak-WebEdit-edit-20261121/index.html /Volumes/HddShare/WebEdit/edit/`（并恢复 888 来源的 CORS） |
| 99 服务/页面新版 | 99 上 `/usr/local/bin/vault-edit.bak-<时间戳>`（每次部署自动留）；页面副本见 git |
| 32 加 LAN 99 来源 | `cp /etc/sing-box/config.json.bak-20261121-before-99origin /etc/sing-box/config.json && /etc/init.d/sing-box restart` |
| 甲/乙 加 EasyTier 来源 | 各自 `cp config.json.bak-20261121-133552(-before-easytier-origin)`（乙为 `…133603-before-easytier-origin`）→ `/etc/init.d/sing-box restart` |
| 32 的 Socat 11010 改 udp4 | `cp /etc/config/socat.bak-20261121-before-udpfix /etc/config/socat && /etc/init.d/socat restart` |