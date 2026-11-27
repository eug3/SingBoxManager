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
main.go           入口 + 路由表 + /health（每个接口的实现位置都标在路由表注释里）
config.go         环境变量与常量（密钥只从 env 读；桶名/来源白名单）
httpx.go          writeJSON / fail / setCors / preflight / safeJoin / trunc / sha256Hex
files.go          /edit/（SPA 回退） /static/（Monaco） /rule-set/（只读+DELETE）
buckets.go        GET /rule-set/index（列 NAS 桶目录）+ POST /rule-set/create（新建空桶）+ POST /rule-set/rename（改名，.json/.srs 一起搬）
files_server.go   独立只读文件端口（默认 :9098）：只挂 /rule-set/+/health，管理台不外露
publish.go        POST /publish：规则校验 → sing-box 编译 .srs → 成对写回存储
share.go          ShareFS 抽象：smb(纯Go SMB2)/sftp/local 三实现，会话复用+临时名rename
sharecfg.go       存储运行时配置（SQLite kv）+ /share/config|probe|import + 热替换
share_health.go   /share/health：文件通道+公网 URL 体检（顶栏状态点数据源）
db.go             SQLite（modernc.org/sqlite，无CGO）：kv/routers/publish_log/apply_log + 一次性迁移
router_store.go   SSH 凭据（SQLite routers 表）+ /router/credentials 三接口
router_ssh.go     SSH 通道（3 次退避重试、双缓冲）+ 远端编排（读/check/apply/restart/健康/回滚）
router_http.go    /router/* 鉴权（VAULT_KEY 或 clash secret）+ 配置操作接口
router_clients.go /router/clients：DHCP 租约+ARP → IP→MAC/主机名（① 电脑按 MAC 归并）
public_rules.go   规则路径 → 改写 route.rule_set[].url（preview/apply，复用 apply 通道）
rules_summary.go  /router/rules：config 的 rule_set/route.rules 结构化摘要（纯函数+单测）
service_test.go   纯函数单测（go test ./...）
rules_summary_test.go  rules 摘要单测
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
app.ts / app.html          根壳：顶栏（存储状态点+齿轮）+ 主 tab（规则编辑顶右）+ 页脚
backend-pane.ts / .html    一台路由的面板：概览/分组/连接/流向/日志/规则/配置 子页 + 待保存条 + 编辑弹窗宿主；头部统计条读 LiveStatService 的共享快照
connections.ts / .html     「连接」子页：活跃/已关闭/全部三档 + 搜索/筛选/排序/分组/列设置 + 详情抽屉（订阅共享连接快照做差分）
connections-model.ts       连接纯函数：快照差分(速率/空转/已关闭)/搜索正则/排序/筛选/分组/列定义
overview.ts / .html        概览：速率/连接数/内存曲线 + 模式切换 + 网络信息（hist 缓存 localStorage）
config-pane.ts / .html     「配置」子页：门禁→读取→暂存→校验→应用；工具条只留 刷新/编辑 JSON/更多▾；节点表检索 + 新增/编辑走 NodeCreateDialog
rule-editor.ts / .html     「规则编辑」主 tab：左侧文件树（可新建/重命名/删除 JSON，支持右键菜单）+ 右侧 Monaco 读取/校验/格式化/发布
flow-anim.ts / .html       「流向」子页：六列 band 流向图组件（数据加载/rAF 鱼/交互/全屏/缩放/普通·强调视图/微型图/列头 ＋ 新建）
flow-model.ts              流向纯函数引擎：buildStatic/buildFlow/stepActivity/buildLayout/切线/延时分级

—— 编辑/新建弹窗（点 ③/④ 卡片、列头 ＋、或保存缺凭据时弹出）——
rule-set-dialog.ts / .html ③ 规则集：已应用 chips + palette 拖拽/＋ 增删引用
group-dialog.ts / .html    ④ 分组：成员 checkbox（含嵌套分组）+ selector/urltest/负载均衡预设
rule-set-create-dialog.ts / .html ③ 列头 ＋：新建桶 · 引用到分组（入口桶多选/批量新建，出口分组可内联新建）
rule-regroup-dialog.ts / .html  规则行右键「拆解与合并」：把一条规则的多桶引用摊开，拖桶在组间搬（拆/合），空组保存后消失
group-create-dialog.ts / .html    ④ 列头 ＋：tag + 类型（selector/urltest/负载均衡）+ 直接勾成员
node-create-dialog.ts / .html     ⑤ 列头 ＋ 与配置页共用：表单（node-form）/ 分享链接批量（share-link）两页签 + 加分组
ssh-cred-dialog.ts / .html 保存缺 SSH 凭据：user/password/port → setCredentials → 重试保存
share-config.ts / .html    顶栏齿轮：存储模式/SMB/SFTP/本机目录/规则路径/只读端口 + 测试/保存
group-board.ts / .html     分组看板：未分组+各分组列，拖 chip 改成员（=改 config，需重启）
rule-selector.ts / .html   分流规则选择器：route.rules 启用/停用 + ↑↓ 调顺序（域名规则排 IP 桶之前；=改 config，需重启）
rule-order.ts / .html      规则顺序表（「规则」子页）：拖动整行/↑↓ 调序 + 出口列 + 命中列，运行态 GET /rules 降为折叠核对区

—— 全局交互（取代原生 confirm()/alert()，浏览器拦截原生对话框时不会静默）——
confirm-dialog.ts          页内确认框：原生 <dialog> + showModal（顶层/焦点约束/ESC），外观复用 .modal
toast.ts                   右下角提示条堆叠：可叠多条、点击即关、到点自动消失

—— 服务层（Injectable，全部 providedIn: 'root'）——
backends.service.ts        后端列表 + 全局密钥（localStorage；草稿只在内存）
clash.service.ts           clash_api 客户端（浏览器直连路由；REST + WebSocket）
vault.service.ts           规则桶读写（/rule-set/<桶>.json、/rule-set/index 清单、/publish）+ 前端预校验
router.service.ts          /router/* 客户端（X-Vault-Key = 该后端 clash 密钥）
config-draft.service.ts    配置草稿：baseDoc/draft/dirty/stage/cancel/save（凭据预检+乐观锁）
live-stat.service.ts       连接快照唯一轮询者：subscribe(backend, ms)→snap 信号（at 去重），末位退订即停、隐藏页跳过
confirm.service.ts         确认框状态机：ask({title,body,details,danger})→Promise<boolean>，队列逐个显示
toast.service.ts           提示条状态机：show/ok/error + 自动消失（取代 alert）
share-health.service.ts    /share/health 周期体检 + /share/config|probe|import 客户端

—— 纯函数模块（不碰组件状态，可单测）——
config-ops.ts              config.json 结构化增删改 + 引用联动 + 结构校验 + 保风格序列化
group-board-model.ts       看板纯函数：readBoard / moveMember（clone 不改入参、default 联动）
rule-model.ts              分流规则纯函数：readRuleModel / filterRouteRules
node-form.ts               节点表单模型：emptyForm / formFromNode / buildNode（按协议校验组装）
share-link.ts              分享链接解析：ss/vmess/vless/trojan/hysteria2/socks → outbound
line-diff.ts               LCS 行级 diff（暂存变更预览）
util.ts                    字节/速率格式化、延迟分级、错误文案、并发池 runPool
area-chart.ts              轻量 SVG 图表（曲线/柱形，固定格数窗口，non-scaling-stroke 细线）
monaco-editor.ts           Monaco 受控封装（本站 AMD loader，离线可用）
models.ts                  接口类型 + 常量（页面来源/延迟阈值/版本号）
```

### 3.0 「连接」子页（connections + connections-model）

浏览方式对齐 zashboard 的 `/ui/#/connections`，但数据源是 sing-box 的 clash_api（只回活跃连接）：

- **三档视图**：活跃 / 已关闭 / 全部。`ConnTracker.apply` 把相邻两次快照做差，消失的 id 记为已关闭（保留 500 条），
  同时用「字节增量 / 时间差」算实时速率、用「最近一次字节增长」算空转。
- **搜索即正则**：空格分隔的每个词各自是正则（AND），词命中的字段之间 OR；非法正则降级为同字面量匹配，
  命中片段在单元格里用 `<mark>` 高亮。漏斗按钮切换「只看可见列 / 全部字段」。
- **筛选**：源 IP（多选，按 IP 不按端口）、网络类型、出口（chains[0]）、存活档位（≥1/5/30 分）、空转 ≥1 分；
  另有一条「快速隐藏」正则（默认 `direct|dns-out`）整行藏掉，并单独显示被藏条数。
- **排序 / 分组**：点列头三态循环（数值列先降序、文本列先升序），分组可按源 IP / 规则 / 出口 / 链 / 网络 / 入站 /
  主机 / 进程，组头显示条数与累计流量，可逐组或一键收起。
- **列**：显隐与顺序可配（localStorage 持久化，可恢复默认），链支持「出口 → 分组 / 分组 → 出口」与完整链折叠。
- **详情抽屉**：点行打开，按「连接 / 来源 / 目标 / 路由 / 流量」分节 + 原始 JSON；右键单元格复制、Esc 关闭。
- **断开**：单条 ✕、当前筛选批量、全部断开（都有确认；无筛选时确认文案会点明「会断开全部」）。
- 无 router 时用 `scripts/mock_clash.mjs` 起假 clash_api（同时托管 ng 产物）验收，见 `docs/plan-connections-browser.md`。

### 3.1 「流向」子页（flow-model + flow-anim）

六列 band 模型：①电脑(按 MAC 归并) → ②路由器 → ③规则集(一个桶一块·书图标小方块) →
④分组 → ⑤组成员方格(逐行·跨组重复) → ⑥互联网(一朵云)。五个数据源合流：
静态 config(30s) + 实时 connections(1.5s) + clients 名册(30s) + delays 测速(5s) + activity(字节增长)。
动态语义：活跃边=绿点虚线、活跃节点=绿描边（停 4s 回落）；小鱼只游活跃链路（切线朝向+摆尾）；
⑤ 方格右上延时点红黄绿、④ 卡右下平均延时点、所属组当前成员左下橙点。
交互：点 ③/④ 开编辑弹窗；点 ⑤ 成员方格弹固定层（节点信息 + 「激活」= `PUT /proxies/<组>`
切所属 Selector 的当前成员 + 「测速」= 单节点 `GET /proxies/<成员>/delay`，URLTest 只给测速）；
**③④⑤ 列标题后面各有一个 ＋**（①②⑥ 没有）：③ 新建规则集、④ 新建分组、⑤ 新建节点。
三个新建弹窗都只产出新 `ConfigDoc`（`docChange`），由宿主决定暂存链——流向页接
`ConfigDraftService.stage`（顶部待保存条），配置页接 `enterReview`（文本暂存 + diff），
与 ③④ 编辑弹窗口径一致；点「保存并重启」才写回路由。
hover 高亮、⛶ 全屏、自适应⇄100%、右下角速率/内存微型图（ws /traffic + /memory）。

**③ ＋ 的语义**：流向 ③ 的方块来自 `route.rules` 里引用的桶（`flow-model.buildStatic` 的 tiles），只往
`route.rule_set` 塞定义不会出现在图上，所以弹窗一次写两件事——新增定义
（remote/local、format、url/path、update_interval，URL 默认按现有 remote 桶的前缀拼）
＋ 给选定出站加一条引用（已有 rule_set 规则就扩展数组，否则插在 final 兜底规则前，见
`config-ops.addRuleSetRef`）。桶文件（NAS `<tag>.json/.srs`）不在弹窗里建：会用
`/rule-set/index` 查一下并提示「先到规则编辑建桶并发布」，避免路由拉取 404。

### 3.2 「配置」子页的状态流

```
backend 变化 / 密钥变化
   └─ effect ─▶ 无密钥？──▶ 连接门禁（像登录页：clash 密钥 + SSH 账号）
                有密钥 ──▶ reload()（/router/config，记 original + sha）
节点弹窗（新增/编辑/分享链接导入）/删除/分流规则/分组看板/Monaco 手改
   └─▶ raw ≠ original ⇒ pending（黄色「已暂存变更」横幅 + diff）
        ├─ 校验 ─▶ /router/check（路由上真跑 sing-box check）
        ├─ 应用 ─▶ /router/apply（带 expectSha 乐观锁；409=他人已改）
        └─ 撤销 ─▶ raw = original
```

工具条收成三档：刷新 / 编辑 JSON / 更多▾（重启 sing-box、分流规则、分组看板、路由凭据）；
节点表带检索与「＋ 新增节点」，新增/编辑都开 `node-create-dialog`（与流向 ⑤ 同一个组件）。
原来 分流规则 / 分组看板面板在只读视图里被渲染两次（两套实例各自一份停用集合，状态会打架），
现已只保留一处。

结构化编辑（节点/删除/看板/规则）都走 `config-ops.ts`：改完按**原文件的缩进与行尾**
重新序列化（`serializeConfig`），所以 diff 里只多出个别「手写紧凑处被规范化」的格式行。

### 3.3 去重收敛点（本次重构）

| 原来 | 现在 |
|---|---|
| 字节格式化在 overview / backend-pane / vault.service 各一份 | `util.fmtBytes`（统一 B/K/M/G） |
| 延迟分级/文本在两个组件各一份、阈值常量两套 | `util.latClass/latText` + `models.LAT_LOW/LAT_MID` |
| 「全部测速」并发池在两处手写 | `util.runPool`（并发 6 不变） |
| diff 算法内嵌在 config-pane（638 行） | `line-diff.ts`；config-pane 降到 ~490 行 |
| 表单校验/组装内嵌在 config-pane | `node-form.ts`（buildNode 返回 ok/error，组件只展示） |
| 规则顺序只能改 JSON | `config-ops.moveRule` + 面板 ↑↓；新建引用按域名/IP 选插入点（`ruleInsertPoint`/`previewRuleSetRef`） |
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