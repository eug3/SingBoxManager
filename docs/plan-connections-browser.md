# 规划：连接页复刻 zashboard `/ui/#/connections` 的浏览方式

> 2026-11-23 实现并自测通过（浏览器 + 假 clash_api 实测，见 §6 验收证据）。
> 目标：把管理台「连接」子页从「一张 120 行的表 + 关键字过滤 + 年龄档位」升级成 zashboard 那样的连接浏览器：
> 三档视图、搜索即正则、多维筛选、列头排序、按字段分组、列显隐可配、行详情抽屉、批量断开。

## 1. 对照表：zashboard 有什么 / 本仓怎么做

| zashboard `/connections`                                     | 本仓实现                                                                 | 说明 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ---- |
| 活跃 / 已关闭 / 全部 三档，Tab 上带计数                       | 同（`tab` 信号 + `ConnTracker` 差分出已关闭，最多 500 条）               | sing-box 只回活跃连接，已关闭靠快照差分 |
| 搜索框（空格 = 多个正则 AND）+ 命中高亮 + 「可见列/全部列」范围 | 同（`parseSearch` / `highlightParts`，非法正则降级为字面量）             | 高亮用 `<mark>`，不碰 innerHTML |
| 快速隐藏正则（默认 `direct\|dns-out`）                        | 同（筛选条 chip 一键开关 + 列设置里改正则）                              | 单独显示「正则隐藏 N」 |
| 源 IP 筛选下拉                                               | 浮层多选（按 IP 计数，不按端口）                                         | sing-box 的 `sourcePort` 另设列 |
| 列头排序                                                     | 同：三态循环（无 → 升 → 降 → 无），数值列第一下按降序                    | 排序状态持久化 |
| 列显隐 / 顺序 / 列宽                                         | 显隐 + 顺序（localStorage 持久化，可恢复默认）；**列宽不做拖拽**          | 列宽用固定权重 + 容器横向滚动 |
| 分组（group by 列）                                          | 源 IP / 规则 / 出口 / 链 / 网络 / 入站 / 主机 / 进程，组头带条数与流量     | 组可逐组或一键收起 |
| 代理链方向 / 完整链                                          | 出口 → 分组 / 分组 → 出口；>2 段可折叠成「出口 › … › 分组」               | 与 sing-box 的 chains 顺序一致 |
| 暂停（冻结列表便于查看）                                     | 「自动 2s」开关：关掉即停轮询，列表冻结；再开立刻补一拉                   | 页面隐藏时自动跳过 |
| 行点击 → 详情抽屉（overview / raw）                          | 右侧抽屉：连接 / 来源 / 目标 / 路由 / 流量 五节 + 原始 JSON + 复制        | 抽屉跟着新快照刷新同一条 |
| 右键单元格复制                                               | 同（复制成功给轻提示）                                                   | 链按当前显示方向复制 |
| 关闭单条 / 关闭筛选 / 关闭全部                                | 同（都带确认；无筛选时文案点明「会断开全部 N 条」）                       | sing-box 无 block 接口，不做「降级拦截」 |
| 虚拟滚动                                                     | **不做**：默认 420 条量级，Angular 信号 + 固定列宽实测流畅；超过 1000 条再议 | 已关闭列表上限 500 |
| GeoIP / 进程 / 入站用户列                                    | 列为可选（不在默认列里），GeoIP 需要外部库，**不做**                      | 进程列有数据时显示 |
| 卡片视图 / 表头固定列 / 列宽拖拽                             | **不做**（本仓是键盘鼠标并重的窄屏管理台，表格模式足够）                  | 保持实现面窄、可维护 |

## 2. 数据（全部来自 clash_api `/connections`）

sing-box 1.15 的应答形状（实测 2026-11-23，乙路由 172.16.8.1）：

```json
{ "connections": [{ "id": "...", "upload": 1, "download": 2, "start": "2026-11-23T04:09:14Z",
  "chains": ["ali.vmess", "BALANCE", "🐟 漏网之鱼"], "rule": "rule_set=rs-fcm => route(📢 谷歌FCM)",
  "rulePayload": "",
  "metadata": { "destinationIP": "117.62.172.151", "destinationPort": "11011", "dnsMode": "normal",
    "host": "", "network": "udp", "processPath": "", "sourceIP": "172.16.8.105",
    "sourcePort": "63514", "type": "tun/tun-in" } }],
  "downloadTotal": 0, "uploadTotal": 0, "memory": 0 }
```

口径：
- `chains[0]` = 实际出口，末位 = 分组；`rule` 自 1.15 起就是完整表达式，表格里压成「条件 ⇒ 出站」，原文进 title 与详情。
- `host` 经常为空 → 主机列按 `host → sniffHost → destinationIP` 兜底；来源筛选用 `sourceIP`（不带端口）。
- 无 `closed` 字段 → 已关闭 = 上一轮有、这一轮没有的 id（`ConnTracker`）。

## 3. 文件

| 文件 | 动作 | 职责 |
| ---- | ---- | ---- |
| `web/console/src/app/connections-model.ts` | 新增 | 纯逻辑：列定义、字段兜底、`ConnTracker` 差分、搜索/高亮、排序、筛选、分组、汇总 |
| `web/console/src/app/connections.ts` | 新增 | 连接子页组件：2s 轮询、视图状态与持久化、浮层/抽屉、断开与复制 |
| `web/console/src/app/connections.html` | 新增 | 工具条 + 筛选条 + 表格（列头排序 / 分组行 / 高亮）+ 状态条 + 抽屉 |
| `web/console/src/app/backend-pane.ts / .html` | 改 | 连接子页改为 `<app-connections>`；面板不再自持连接列表，只收 `stats`（活跃条数 + 累计流量） |
| `web/console/src/app/models.ts` | 改 | `ConnMeta`：补 sourceIP/sourcePort/type/dnsMode/processPath/user |
| `web/console/src/app/util.ts` | 改 | `ageText` / `ageClass` / `clockText` 收敛到这里；`fmtRate` 的 B/s 分支取整 |
| `web/console/src/styles.css` | 改 | 连接子页样式段（`.cn-*`）；删掉旧连接表的 `.connstat` / `td.age` / `tr.oldconn` |
| `scripts/mock_clash.mjs` | 新增 | 假 clash_api + 静态托管 ng 产物，用于无路由环境验收 |
| `docs/architecture.md` | 改 | 模块表 + §3.0「连接」子页要点 |

## 4. 交互细节

- **工具条**：三档视图 / 搜索（漏斗切范围、✕ 清筛选） / 源 IP / 网络 / 出口 / 分组 / 列 / 自动 2s / 刷新 / 断开筛选 / 全断。
- **筛选条**：存活全部·≥1分·≥5分·≥30分、空转 ≥1 分、快速隐藏 chip、命中数与被正则藏掉的条数。
- **表格**：表头 sticky；行 hover 高亮；存活 ≥5 分红字、空转 ≥1 分红字；偏老 / 空转行给极浅底色；
  「已关闭」视图不显示断开列，行整体置灰并带 tooltip。
- **底状态条**：共 N / 命中 M / 正则隐藏 H / 活跃与老连接、空转候选、最老存活 / ↓↑ 累计 / ↓↑ 实时速率 / 自动刷新状态 / 最后更新时间 / 拉取错误。
- **持久化**（localStorage）：`connTab` `connColumns` `connSort` `connScopeAll` `connHideRe` `connHideOn` `connAuto`
  `connGroupBy` `connChainDir` `connFullChain`。筛选值（搜索词、源 IP、存活档位）**不持久化**，刷新即重置。

## 5. 边界与已知取舍

- 断开后先本地移除，下一轮快照会把它记进「已关闭」（与 zashboard 一致）；已关闭连接不能再断。
- 速率是「两帧字节差 / 时间差」，2s 一帧，短暂尖峰正常（间隔下限按 0.2s 兜底，避免抖动放大）。
- 400+ 行不虚拟滚动：列数固定、行高固定，实测刷新与排序无明显卡顿；真到 1000+ 条再上窗口化。
- 无筛选时「断开筛选」= 断开全部，确认弹窗会点明；「全断」按钮显式存在。

## 6. 验收（2026-11-23）

环境：本机 `node scripts/mock_clash.mjs`（420 条连接，含 8% 永不增长字节的僵死样本、12% 会自然下线的连接），
Chrome 157 headless（1500×960 与 1280×800 两档）逐项实测：

| 项 | 结果 |
| --- | --- |
| 生产构建 | `npx ng build --base-href=/edit/` 通过：main 408.78 kB / styles 36.26 kB，无预算告警 |
| 三档视图 | 活跃 420 / 已关闭 11~27（随快照下线增长）/ 全部 = 两者之和 |
| 搜索 | `openai|anthropic|claude` → 命中 140/420，命中片段高亮；输入 `(` 不报错（按字面量匹配） |
| 排序 | 「↓累计」→ 降序（4.0M→3.9M…），三态循环可清除；排序提示「按↓累计 降序」 |
| 快速隐藏 | `direct|dns-out` → 命中 264/419、正则隐藏 155 |
| 源 IP | 候选 6 个（按 IP 不按端口），勾 2 个 → 命中 96 |
| 分组 | 按源 IP 分组：`192.168.31.8 · 76 条 · ↓156.9M ↑16.6M`，收起/展开正常 |
| 详情抽屉 | 五个小节 + 原始 JSON；点行打开、Esc / 点遮罩关闭、断开按钮生效 |
| 列设置 | 显隐/顺序生效；隐藏「网络」列后刷新页面仍隐藏（localStorage） |
| 暂停 | 关闭「自动 2s」后列表冻结（字节读数不变、状态条显示已暂停），再开立刻恢复 |
| 断开 | 单条 ✕：活跃 420→419 且出现轻提示；批量断开走确认弹窗 |
| 右键复制 | 单元格右键 → 「已复制 主机」轻提示 |
| 窄窗 | 1280×800 工具条自动换行、表格横向滚动，状态条不溢出 |

另：`npx ng build`（development）无 ERROR；TypeScript 严格选项下无隐式返回/未用变量告警。

## 7. 上线记录（2026-11-23）

- 功能提交 `a763d90`；经 `scripts/deploy_console.sh` 发布到管理机 `/usr/local/share/vault-edit/edit/`，**未重启 Go 服务**（全程 `active`）。
- 运行方式：`LC_ALL=C LANG=C ROUTER_PW='…' scripts/deploy_console.sh`。不带 `LC_ALL=C` 的第一次在第 2 步就中止
  （`MONACO_VERSION…: unbound variable`，见 runbook 坑 17），中止在上传之前，线上未受影响。
- 产物：`main-MR2JZO4L.js`（408,931 B）/ `styles-KJ436Q4N.css`（36,265 B）/ `index.html`；三个文件的 sha256 远端与本地生产产物**逐字节一致**
  （`3b15fcc6…98d69` / `a73b53bd…6069357` / `99040aac…41808`）。
- 回滚点：`edit.bak-20261123-005236`（内为改版前的 `main-BOBT4ETC.js`；时间戳是管理机 EDT 时区）。Monaco 仍是 0.57.0，未重传。
  远端临时文件（含口令文件）已被脚本清空。
- **线上只读实测（乙路由 172.16.8.1，真实数据，无头 Chrome 从开发机加载 `http://192.168.31.99:9099/edit/`）**：
  - 载入 / 切乙 / 进连接页三个阶段**零失败请求**，来源受信无横幅；
  - 三档计数随真实流量变化（活跃 133→150、已关闭 6→19）；头部统计条与连接页活跃数一致（133↔133、136↔136）；
  - 真实规则被正确压短：`ip_is_private=true ⇒ direct`、`rs-msft ⇒ Ⓜ️ 微软服务`、`cn_ip ⇒ DIRECT`、`bard-domains ⇒ Bard`；
    抽屉「路由」节保留完整原文 `rule_set=cn_ip => route(DIRECT)`；
  - 搜索 `windows` → 命中 4、高亮 4 处；「存活」「↓速率」排序与提示正确；按出口分组：`DIRECT 69 / shayuqite 15 / iplc-ss 15 / direct 12 / lan-fd-sa 11`；
  - 抽屉 Esc 关闭正常。
- **未覆盖**：① 断开类操作（单条 / 批量 / 全部）只在 mock 上验证过，线上实测刻意不点；② 甲路由（192.168.31.32）见 §8。
- 与 zashboard 的一处有意差异：「存活」列第一下是**最老在前**（本页用途是揪老连接），zashboard 的连接时间列是最新在前。
  要对齐只需去掉 `COLS` 里 `age` 列的 `num: true`。

## 8. 上线验证时发现的甲路由现状（与本次改动无关，仅记录）

以下均为开发机 / 管理机上的只读探测，未登录、未改动甲路由：

- 管理机 99 → `192.168.31.32:9090`：两次采样都是**立即拒绝连接**（`Could not connect … after 0 ms`）；`9091` 端口开着，但对明文 HTTP 与 TLS 都是对端立即关闭。
  按记忆，11-21 时甲的 clash_api 还是 `0.0.0.0:9090`、无 secret 返回 401。所以管理台「甲」tab 此刻加载不出数据，本次线上验证只覆盖了乙。
  该现象在本轮任何改动之前就已存在（会话开头第一次探测即超时）。
- 经甲路由出网（99 的默认网关是甲）：ICMP、gstatic 204、百度 HTTP/HTTPS 都能通，但建连偏慢（百度 1~3 秒）且**偶发超时**
  （一轮里 `https://www.baidu.com` 连 TCP 都没建起来、github 读到 16 KB 后停住，下一轮均 200）；99 走自己的 SOCKS 出口 0.9 秒即通。
- 开发机 Mac 的网关与 DNS 都是 `172.16.8.1`（乙），从它测 `192.168.31.32:9090` 会得到「TCP 能连上但无应答」——那是乙的 TUN 本地终结握手的假象，
  判断甲路由端口要以 99 上的探测为准（runbook 坑 10 的延伸）。
- 待办（需用户授权登录甲路由后才能定位）：在甲上看 `ss -ltnp | grep -E '9090|9091'`、sing-box 进程 / FD / `nf_conntrack_count`，以及 clash_api 监听是否被改。
