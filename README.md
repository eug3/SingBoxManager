# SingBoxManager

双路由 **sing-box** 分流规则的托管仓库 + 内网管理台。

两台路由（甲 `192.168.31.32` OpenWrt / 乙 `172.16.8.1` GL-BE3600）的**全部域名/IP 分流规则**托管成 23 个远程 rule-set 桶放在 NAS 上，
改 NAS 文件 → 两台路由 60 秒内自动拉取生效，**全程零重启**；规则的编辑、发布、节点切换、流量/连接/日志监控集中在一台内网 99 号机（`192.168.31.99:9099`）的管理台里，公网只保留只读页面。

---

## 架构

```
                          ┌──────────── NAS /Volumes/HddShare/WebEdit ─────────────┐
   公网 (Cloudflare Tunnel)│ index.html(脱敏首页)  rule-set/*.json|*.srs  zashboard/ │
        ─── 只读 ────────▶ │                                          ▲             │
                          └──────────────────────────────────────────┼─────────────┘
                                                                     │ 编译产物写回
  浏览器 ── LAN / EasyTier ──▶ 99 号机  vault-edit (Go, :9099) ◀──────┘
        (管理台 Angular 22)     │  GET  /edit/            前端静态（Angular 产物）
                                │  GET  /static/          Monaco 编辑器静态
                                │  GET  /rule-set/*       读 NAS（同源，免 CORS）
                                │  POST /publish          校验 → sing-box 编译 → 写 NAS
                                ▼
            甲 32 sing-box ◀── remote rule-set, update_interval=1m ──▶ 乙 GL sing-box
            (OpenWrt x86_64)                                        (GL-BE3600 aarch64)
```

- **写通道唯一**：规则编译需要 `sing-box` 二进制、写回需要 NAS 挂载，只有 99 号机同时满足，所以管理台与发布接口都放在 99（`/publish` 用 `X-Vault-Key` 鉴权 + 仅内网可用）。
- **读通道**：NAS 上的 `.srs/.json` 由公网首页与路由直接拉取；管理台自己读 `.json` 源走同源接口。

## 组件

| 路径 | 技术栈 | 作用 |
|---|---|---|
| `service/` | Go 1.27（单二进制） | `vault-edit`：静态页面 + `/rule-set/*` + `/publish`（校验/编译/写回），systemd 托管 |
| `web/console/` | Angular 22 + TypeScript 6（signals、zoneless） | 内网管理台：概览曲线、分组/节点、连接、日志、规则、Monaco 规则编辑 |
| `web/edit/index.html` | 原生 HTML/JS（**已退役**） | 上一代单文件管理台，仅作回滚参考，不参与部署 |
| `web/index.html` | 原生 HTML/JS | 公网首页（脱敏：只有桶卡片与体积/时间，无 IP/节点/拓扑） |
| `scripts/` | Bash | 部署（`deploy_service.sh` / `deploy_console.sh` / `deploy_web.sh`）、体检（`check.sh`）、CLI 发布（`publish.sh`） |
| `docs/runbook.md` | 文档 | 运维手册：桶清单、路由配置口径、坑位、回滚表 |
| `docs/deploy.md` | 文档 | 从零部署与升级的完整步骤 |

## 关键地址

| 用途 | 地址 |
|---|---|
| 管理台（内网 LAN） | `http://192.168.31.99:9099/edit/` |
| 管理台（EasyTier 虚拟网） | `http://10.1.1.99:9099/edit/` |
| 公网只读首页 | `https://router.guaishoudejia.com/` |
| zashboard（备选看板） | `http://192.168.31.8:888/zashboard/` |
| 甲 / 乙 clash_api | `192.168.31.32:9090` / `172.16.8.1:9090` |

管理台两个入口等价；浏览器会**直连**路由的 `clash_api`，所以两台路由的
`access_control_allow_origin` 必须包含页面来源（精确 origin，不能写网段）：

```json
"access_control_allow_origin": ["http://192.168.31.8:888",
                                "http://192.168.31.99:9099",
                                "http://10.1.1.99:9099"]
```

## 快速部署

前置：macOS/Linux 开发机（Go 1.27+、Node 24+、`sshpass`），99 号机（Debian，可 sudo），NAS 已挂到 99 的 `/mnt/hdd`，99 上有 `sing-box` 二进制。

```bash
# 0) 只在本机导出，不写进仓库
export ROUTER_PW='99号机口令'        # 99 的 sudo 口令
export VAULT_KEY='<clash_api secret>' # 两台路由 clash_api 的 secret

# 1) 后端（Go 二进制 + systemd，改服务端才需要）
scripts/deploy_service.sh

# 2) 前端（Angular 构建 + Monaco 静态；日常改页面只跑这个，不重启服务）
scripts/deploy_console.sh

# 3) 公网首页（改 web/index.html 才需要）
scripts/deploy_web.sh

# 4) 体检：管理台/公网/CORS/桶全绿
VAULT_KEY="$VAULT_KEY" scripts/check.sh
```

详细步骤（99 一次性初始化、路由侧 CORS 与重启口径、回滚、FAQ）见 **[docs/deploy.md](docs/deploy.md)**。

## 日常操作

- **改规则**：管理台 → `🧩 规则编辑` → 选桶 → 编辑（Monaco）→ `保存并发布` → 两台路由 60s 内自动拉取。
- **看/切节点**：管理台后端 tab → `分组与节点`（Selector 组可点切换，URLTest 组只读、按延迟自动选）。
- **看流量/连接/日志**：后端 tab → `概览`（下载/上传/连接数/内存曲线，1s 采样，可选 1/5/10 分钟窗口）、`连接`、`日志`。
- **多后端**：`＋ 添加后端` 可挂任意 clash_api（名称/地址/密钥存本浏览器 localStorage）；地址没填=草稿，刷新即消失。
- **不用管理台时**：直接改 NAS `rule-set/*.json` 再编译成 `.srs` 也可以，见 `scripts/publish.sh` 与 runbook。

## 安全口径

- **仓库内无任何密钥**：`VAULT_KEY` 只经环境变量 → 落到 99 的 `/etc/vault-edit.env`（`0600`）；路由 secret 只在路由配置里。
- 管理台只监听内网；`/publish` 必须带 `X-Vault-Key`，缺失返回 401。
- 公网只暴露脱敏首页、rule-set 与 zashboard，**不含管理台**（`/edit/` 在公网是 404）。
- 凭据登记表在 NAS `credentials/dev-and-test-password.txt`（不入库）。
- 建议定期轮换 clash secret 与 `VAULT_KEY`（两者当前相同，轮换时同步 99 的 env 与两台路由配置）。

## 故障排查（最常见的 6 个坑）

| 现象 | 原因与处理 |
|---|---|
| 管理台后端页底部提示 401 | 该后端密钥未填 → 顶部「发布密钥」或后端配置里填 `clash_api` secret |
| `Failed to fetch` / 无 ACAO | 路由 `access_control_allow_origin` 没含**精确**页面来源（`http://192.168.31.99:9099`、`http://10.1.1.99:9099`） |
| `/edit/` 白屏或 `main-*.js` 404 | 只覆盖了 `index.html`；必须整目录替换（`deploy_console.sh` 已处理，Go 侧 `/edit/` 有 SPA 回落） |
| Monaco 编辑器不出来 | 99 上缺 `/usr/local/share/vault-edit/static/monaco/vs`（`deploy_console.sh` 会自动铺） |
| 99 上 `ping 10.1.1.x` 全超时但 peer 表正常 | EasyTier 数据面被 32 的 Socat 转发毒化（`udp → tcp4`），修法见 runbook 坑 12 |
| 规则改了不生效 | 桶内容没变（按 hash 判定）/ 未过 60s 拉取窗口 / NAS 写回失败，看路由日志 `update rule-set <桶>` |

更多坑位与回滚见 [docs/runbook.md](docs/runbook.md)。

## 目录结构

```
service/            Go 服务（main.go / go.mod / vault-edit.service）
web/console/        Angular 22 管理台（src/app: overview, backend-pane, rule-editor, monaco-editor …）
web/edit/           已退役的单文件管理台（回滚参考）
web/index.html      公网只读首页
scripts/            deploy_service.sh / deploy_console.sh / deploy_web.sh / check.sh / publish.sh
docs/               runbook.md（运维手册）· deploy.md（部署手册）
HANDOFF.md          交接摘要
```

## 相关文档

- [docs/deploy.md](docs/deploy.md) —— 部署/升级手册
- [docs/runbook.md](docs/runbook.md) —— 桶清单、路由配置口径、坑位、回滚表
- [HANDOFF.md](HANDOFF.md) —— 当前状态与待办交接