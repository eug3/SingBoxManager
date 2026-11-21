# 代码架构（2026-11-21 重构后）

> 本文描述仓库的模块划分与数据流。主机一律用角色名：**管理机**（跑 vault-edit 的 Debian）、
> **路由 A/B**（sing-box 网关）、**NAS**（规则仓库）、**开发机**（构建与部署）。
> 真实地址见内部运维资料，不进本仓库。

## 1. 三个可独立发版的单元

```
┌─ 开发机 ─────────────────────────────────────────────────────────┐
│  go build ──▶ vault-edit 二进制 ──scripts/deploy_service.sh──▶ 管理机 │
│  ng build ──▶ Angular 产物     ──scripts/deploy_console.sh──▶ 管理机 │
│  web/index.html               ──scripts/deploy_web.sh─────▶ NAS    │
└──────────────────────────────────────────────────────────────────┘
```

| 单元 | 位置 | 发版脚本 | 重启影响 |
|---|---|---|---|
| Go 服务 `vault-edit` | 管理机 `/usr/local/bin/vault-edit`（systemd） | `deploy_service.sh` | 重启服务（毫秒级，不影响路由） |
| Angular 管理台 | 管理机 `/usr/local/share/vault-edit/edit/` | `deploy_console.sh` | 无需重启（纯静态文件替换） |
| 公网首页 | NAS `WebEdit/index.html` | `deploy_web.sh` | 无（NAS nginx 约 1min 缓存） |

## 2. Go 服务（service/，单包多文件）

```
main.go          入口 + 路由表 + /health（每个接口的实现位置都标在路由表注释里）
config.go        环境变量与常量（密钥只从 env 读；桶名/来源白名单）
httpx.go         writeJSON / fail / setCors / preflight / safeJoin / trunc
files.go         /edit/（SPA 回退） /static/（Monaco） /rule-set/（NAS 只读）
publish.go       POST /publish：规则校验 → sing-box 编译 .srs → 成对写回 NAS
router_store.go  SSH 凭据存储（0600 原子写）+ /router/credentials 三接口
router_ssh.go    SSH 通道（3 次退避重试）+ 远端编排（读/check/apply/restart/健康/回滚）
router_http.go   /router/* 鉴权（VAULT_KEY 或 clash secret）+ 四个操作接口
service_test.go  纯函数单测（go test ./...）
```

### 2.1 两条写通道，职责不混

| 通道 | 写什么 | 生效方式 | 鉴权 |
|---|---|---|---|
| `POST /publish` | NAS 上的**规则桶**（.json+.srs） | 路由 remote rule-set 约 60s 自动拉取，**零断流** | 只认 `VAULT_KEY` |
| `POST /router/apply` | 路由上的**整份 config.json** | 备份→check→原子替换→重启→健康检查→失败回滚，断流约 1–2s | `VAULT_KEY` 或该路由 clash_api 认可的 secret |

### 2.2 路由配置通道为什么在管理机侧编排

sing-box 没有 reload/写配置 API（Clash API `PUT /configs` 是空实现；1.15 的
`services{type:"api"}` 是 gRPC 运行时观测）。所以改配置只能「替换文件 + 重启」。
编排全部在 `router_ssh.go`：SSH 上传候选配置到路由 `/tmp`，再执行内联脚本完成
check/备份/替换/重启/健康判定/回滚 —— **路由上不需要预装任何脚本**。

两个实测踩过的坑（代码里有对应注释）：
- `x/crypto/ssh` 的 `Stdout`/`Stderr` 不能共用同一个 `bytes.Buffer`（静默丢输出）；
- 健康判定必须「换新 pid **且** :9090 监听」，只看端口会被旧进程残留 socket 骗过。

### 2.3 规则桶存储：纯 Go SMB2（不再依赖 cifs 挂载）

`share.go` 抽象出最小文件接口 `ShareFS`，三种实现用 `SHARE_MODE` 切换：

| 模式 | 实现 | 依赖 |
|---|---|---|
| `smb`（默认） | `github.com/cloudsoda/go-smb2`，直连 NAS `445` | 纯 Go，**不需要任何挂载** |
| `sftp` | `github.com/pkg/sftp` + `x/crypto/ssh` | 纯 Go；NAS 开了 SSH 时可用 |
| `local` | 本地目录（旧的 `/mnt/hdd` 用法） | 需要内核 cifs 挂载 |

NAS 侧共享是 `sec=none`（guest），所以零凭据即可读写；若以后要账号，用
`SMB_USER/SMB_PASS/SMB_DOMAIN`（或 `SFTP_USER/SFTP_PASS/SFTP_KEY`）从
`/etc/vault-edit.env` 注入，不进仓库。

写入采用「临时名 + rename」，路由不会拉到半截文件；会话失败会自动重连重试一次。
`GET /share/health` 是这套通道的体检接口：文件通道（模式/文件数/样本大小/耗时）
+ 公网 URL（状态码/字节数/耗时），顶栏那个状态点就是它。

**配置不再硬编码**：存在 `/etc/vault-edit/share.json`（0600），管理台顶栏状态点后面的
⚙ 可以改（存储模式/地址/共享路径/账号/口令/公网入口/只读文件端口），保存即热生效
（口径见 `sharecfg.go`：`GET/POST /share/config`、`POST /share/probe`（只测不存）、
`POST /share/import`（把当前共享复制到 99 本机目录））。

**只读文件服务跑独立端口**（`filesListen`，默认 `:9098`，`files_server.go`）：
它只挂 `/rule-set/*` 与 `/health`，`/edit`、`/router/*`、`/publish` 一律 404。
所以「文件对外」和「控制台对内」可以分开：对外只反代 9098，9099 继续只在内网。

### 2.4 SQLite 后端（替代散落的 JSON）

`db.go`（纯 Go 驱动 `modernc.org/sqlite`，无 CGO）把状态收进
`/etc/vault-edit/sbm.db`（0600，WAL）：

| 表 | 内容 |
|---|---|
| `kv` | 存储配置（`shareConfig`）等键值；以后加设置项不用再开文件 |
| `routers` | 路由 SSH 凭据（原 routers.json） |
| `publish_log` | 每次 /publish 的桶、json/srs 字节数、sha、时间 |
| `apply_log` | 每次配置应用/重启的 host、changed、sha、backup、耗时 |

首次启动若库为空，会自动把旧的 `share.json` / `routers.json` 导入（一次性迁移，旧文件保留）。
`GET /db/info` 回显表名与行数 + 最近 5 次发布，页面与体检脚本都用它。

### 2.5 规则路径 → 自动写进路由器规则

两台路由 `config.json` 的 `route.rule_set` 里有 24 条 `type=remote` 规则，`url` 形如
`<规则路径>/<桶>.srs`（规则路径=不带文件名的全路径）。换入口时用：

- `GET /public/rules/preview?base=` —— 每台路由会改几条 + 样例 old→new（只读，不动配置）
- `POST /public/rules/apply {base, confirm:true}` —— 真正改写并走既有
  「备份→check→原子替换→重启→健康检查→失败回滚」通道；内容没变则 `changed=false` 不重启

页面在存储弹窗里：「预览规则改写」→ 看条数 →「写入路由器规则」（会提示断流约 1 秒）。
改完也会在 `apply_log` 留痕。

### 2.6 凭据与密钥的分层

| 凭据 | 存哪 | 谁能看到 |
|---|---|---|
| `VAULT_KEY`（/publish 鉴权） | 管理机 `/etc/vault-edit.env`（0600） | 只有服务进程 |
| clash secret（路由管理密钥） | 浏览器 localStorage + 路由 config.json | 页面用户 |
| 路由 SSH 用户名/口令 | 管理机 `/etc/vault-edit/routers.json`（0600，原子写） | 只有服务进程；接口不回显，页面提交后即清空 |

`/router/*` 的鉴权口径：**能访问 clash_api 就是有密钥** —— 服务端拿请求密钥去
请求路由 `/version`，200 即放行（`router_http.go: routerKeyValid`）。

## 3. Angular 管理台（web/console/src/app/）

Angular 22，standalone + signals + zoneless，无路由库（主 tab 是信号切换）。

```
app.ts / app.html          根壳：顶栏（发布密钥）+ 主 tab + 页脚
backend-pane.ts / .html    一台路由的面板：概览/分组/连接/日志/规则/配置 六子页
overview.ts / .html        概览：速率/连接数/内存曲线 + 模式切换 + 网络信息
config-pane.ts / .html     「配置」子页：门禁→读取→暂存→校验→应用 的状态编排
rule-editor.ts / .html     「规则编辑」主 tab：规则桶读取/校验/发布

—— 服务层（Injectable，全部 providedIn: 'root'）——
backends.service.ts        后端列表 + 全局密钥（localStorage；草稿只在内存）
clash.service.ts           clash_api 客户端（浏览器直连路由；REST + WebSocket）
vault.service.ts           规则桶读写（同源 /rule-set/ 与 /publish）+ 前端预校验
router.service.ts          /router/* 客户端（X-Vault-Key = 该后端 clash 密钥）

—— 纯函数模块（不碰组件状态，可单测）——
config-ops.ts              config.json 结构化增删改 + 引用联动 + 结构校验 + 保风格序列化
node-form.ts               节点表单模型：emptyForm / formFromNode / buildNode（按协议校验组装）
share-link.ts              分享链接解析：ss/vmess/vless/trojan/hysteria2/socks → outbound
line-diff.ts               LCS 行级 diff（暂存变更预览）
util.ts                    字节/速率格式化、延迟分级、错误文案、并发池 runPool
area-chart.ts              轻量 SVG 图表（曲线/柱形，固定格数窗口，non-scaling-stroke 细线）
monaco-editor.ts           Monaco 受控封装（本站 AMD loader，离线可用）
models.ts                  接口类型 + 常量（桶清单/页面来源/延迟阈值）
```

### 3.1 「配置」子页的状态流

```
backend 变化 / 密钥变化
   └─ effect ─▶ 无密钥？──▶ 连接门禁（像登录页：clash 密钥 + SSH 账号）
                有密钥 ──▶ reload()（/router/config，记 original + sha）
表单/导入/删除/Monaco 手改
   └─▶ raw ≠ original ⇒ pending（黄色「已暂存变更」横幅 + diff）
        ├─ 校验 ─▶ /router/check（路由上真跑 sing-box check）
        ├─ 应用 ─▶ /router/apply（带 expectSha 乐观锁；409=他人已改）
        └─ 撤销 ─▶ raw = original
```

结构化编辑（表单/导入/删除）都走 `config-ops.ts`：改完按**原文件的缩进与行尾**
重新序列化（`serializeConfig`），所以 diff 里只多出个别「手写紧凑处被规范化」的格式行。

### 3.2 去重收敛点（本次重构）

| 原来 | 现在 |
|---|---|
| 字节格式化在 overview / backend-pane / vault.service 各一份 | `util.fmtBytes`（统一 B/K/M/G） |
| 延迟分级/文本在两个组件各一份、阈值常量两套 | `util.latClass/latText` + `models.LAT_LOW/LAT_MID` |
| 「全部测速」并发池在两处手写 | `util.runPool`（并发 6 不变） |
| diff 算法内嵌在 config-pane（638 行） | `line-diff.ts`；config-pane 降到 ~430 行 |
| 表单校验/组装内嵌在 config-pane | `node-form.ts`（buildNode 返回 ok/error，组件只展示） |
| Go 单文件 router.go（661 行）混存储/SSH/HTTP | 拆成 store / ssh / http 三文件 |
| Go handler 里重复的 CORS/OPTIONS 八连 | `httpx.preflight` 一行 |

## 4. 脚本（scripts/）

| 脚本 | 作用 | 关键断言 |
|---|---|---|
| `deploy_service.sh` | 交叉编译产物 + unit + env 上管理机，systemd 重启 | /health、/edit/、/static/、无 key 401 |
| `deploy_console.sh` | Angular 产物上传（不动服务） | 页面 200、入口 js 200、/publish 无 key 401 |
| `deploy_web.sh` | 公网首页 → NAS | 首页 200（注意 nginx ~1min 缓存） |
| `check.sh` | 全链路体检（管理台双入口/公网边界/路由 CORS/NAS） | 见脚本内分段注释 |
| `publish.sh` | CLI 发布规则桶 | 本地 JSON 预检 + 服务端校验 |

## 5. 验证口径

- Go：`gofmt -l .` 为空、`go vet ./...`、`go test ./...` 全绿再部署；
- 前端：`ng build` 无 ERROR；部署后用真实浏览器跑「门禁→读取→表单→暂存→校验→应用→还原」闭环；
- 任何 apply/restart 之后必须复核：clash `/version`=200、api 端口可达、出口探测 204；
- 配置改动前的备份都在路由上（`config.json.bak-<ts>-before-apply`），回滚 = cp 回去 + restart。