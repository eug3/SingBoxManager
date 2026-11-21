# 规划：流向动画（五列：我的电脑 → 分流节点 → 分组 → 节点 → 互联网）

> **现状：v2 已把五列改成六列**（电脑 → 路由器 → 规则集 → 分组 → 节点 → 互联网，结构以 config 为主）。
> 往下读到的「五列」是 v1 的记录；现行口径见文末 **「## v2 重做」**（对应 `docs/plan-flow-v2.md`）。

> 2026-11-21 已实现并上线（见 git log）。前端子代理实现 `flow-anim`，lead 集成到「流向」子 tab、回归部署、提交。
>
> 实现补充：⑤「互联网」列落到**具体目标**（host/sniffHost/destinationIP，取前 10）而非单个云图标，
> 这样能直接看出流量目标分布；纵向按类桑基均匀铺开（列高内分布、档距上限 84px）。
> 实测：275 条活跃连接 → 5 列 / 31 节点块 / 131 条边 / 150 个流动粒子（上限生效），
> 列头分别 275 / 275 / 73 / 73 / 145，徽章能显示 `rule_set=… => route(…)`、`BALANCE`、`♻️ 自动选择`、
> `直连`、`拦截`；切走 tab 组件销毁、无泄漏。

## 1. 数据来源（全部来自 clash_api `/connections`，每秒采样）

每条连接的关键字段：

| 字段 | 用途 |
|---|---|
| `metadata.host / destinationIP` | 目标域名/IP（终点标签） |
| `rule` + `rulePayload` | 命中的分流规则（如 `rule_set=rs-openai`） |
| `chains[]` | 实际链路，例：`["OpenAi","ali.vmess"]`（组 → 节点），`["DIRECT"]` 直连 |
| `upload/download` | 用于粒子速度/大小（可选） |
| `id` | 粒子去重键 |

由 chains 推导**五列**布局：

```
①我的电脑  ②分流节点(route 决定的 tag)  ③分组(selector/urltest)  ④节点  ⑤互联网云
  本机  →   OpenAi / Bard / DIRECT …  →  Selector / URLTest  →  ali.vmess …  →  ☁
```

- `chains=["DIRECT"]`：②直连 → 直接连到⑤（不经过③④）。
- `chains=["OpenAi","ali.vmess"]`：②=OpenAi，③=OpenAi（若 OpenAi 是组），④=ali.vmess。
- `chains=["自动选择","v6.sa.vmess"]`：③=自动选择（URLTest，标注「延迟排序/自动」），④=v6.sa.vmess。
- 多条连接共用同一 ②/③/④ 节点时复用同一列坐标（按出现频次排序取前 N 个，N≈10）。

## 2. 动画

- 画布：SVG（列背景 + 连线）+ 顶层粒子层（每帧更新）。
- 粒子：每条**新出现**的连接生成一个粒子（同 id 只生成一次），沿 ①→②→③→④→⑤ 的贝塞尔路径前进；到达终点淡出。上限 ~150 个粒子，超出则丢弃最旧。
- 速度按链路长度归一（约 1.2–2s 走完）；粒子颜色：直连=灰、代理=蓝、block=红。
- 列头显示：①「我的电脑」、②「分流节点（rule → outbound）」、③「节点组（Selector/URLTest）」、④「节点」、⑤「互联网」；节点块上显示名称 + 小徽章（Selector 标「手动」、URLTest 标「延迟排序/自动」、DIRECT 标「直连」）。
- 顶部实时统计：活跃连接数 / 粒子数 / 最近 1s 新增 / 命中规则数。
- 无数据时显示「等待连接…」。

## 3. 交互与性能

- 采样 1.5s/次（`ClashService.connections`），`requestAnimationFrame` 只做粒子推进，组件销毁时取消 rAF 与定时器。
- 布局在 `ResizeObserver` 变化时重算列坐标（保持 SVG viewBox 自适应宽度）。
- 点击某列节点不做跳转（只做展示），hover 显示 tooltip（名称 + 次数）。

## 4. 接入

- 新增子 tab「流向」：`backend-pane` 的 PaneTab 增加 `'flow'`，模板插入 `<app-flow-anim [backend]="backend()" />`。
- 样式沿用 `:root` 变量浅色风格。

## 5. 文件

| 文件 | 职责 |
|---|---|
| `flow-model.ts`（新） | 纯函数：`buildFlow(conns)` → `{cols:{pc[],route[],group[],node[],cloud[]},edges,particlesSeed,stats}`；链路解析、列排序、去重 |
| `flow-anim.ts/.html`（新） | 组件：采样、rAF 粒子、SVG 渲染、tooltip |
| `backend-pane.ts/.html` | 加 `'flow'` tab（标签「流向」） |
| `styles.css` | `.flow*` 样式 |

## 6. 验收

- `ng build` 无 ERROR；浏览器实测有粒子流动、列头/统计正确、切换 tab 后定时器与 rAF 被清理（无泄漏）。
- 纯函数单测式自测：给定 3 条样例连接（DIRECT / selector+节点 / urltest+节点）断言五列内容与边。
## v2 重做（六列：电脑 → 路由器 → 规则集 → 分组 → 节点 → 互联网）

> 2026-11-21 按 `docs/plan-flow-v2.md` 整体重写 `flow-model.ts` / `flow-anim.ts` / `flow-anim.html` 与
> `styles.css` 的 `.flow*` 段。上面的「五列」实现（v1）已被替换，保留本节以备回溯口径。

### 1. 六列与数据来源

| 列 | key | 内容 | 来源 |
|---|---|---|---|
| ① 电脑 | `pc` | 每台 `metadata.sourceIP` 一个小电脑图标（缺省「本机」），右侧是连接数 | 实时 `/connections` |
| ② 路由器 | `router` | 单节点：后端 host + `sing-box <version>` | 后端地址 + `/version` |
| ③ 规则集 | `rule` | `分组名[规则 tag]`，例 `OpenAi[rs-openai]` | **config 解析**（`route.rules[]` + `route.final`） |
| ④ 分组 | `group` | `outbounds[]` 里 type∈{selector,urltest}，badge 手动 / 延迟排序 / 负载均衡 | **config 解析** |
| ⑤ 节点 | `node` | 代理协议出站 + `endpoints[]`，badge 协议简写（ss / hy2 / vless …） | **config 解析** |
| ⑥ 互联网 | `cloud` | 实时目标 `host / sniffHost / destinationIP`（前 10） | 实时 `/connections` |

③ 的 tag 取值顺序（`buildStatic` 里的 `ruleTagOf`）：

1. `rule_set`（字符串或数组取第一个 tag，如 `rs-openai`）→ `OpenAi[rs-openai]`；
2. 无 `rule_set` 时用**规则类型**（`domain_suffix` / `ip_is_private` / `geoip` …）→
   `DIRECT[domain_suffix]`、`DIRECT[ip_is_private]`（同名多规则会各自成块，不会被合并）；
3. 连匹配条件都没有（无条件规则）时：直连 → `DIRECT[直连]`、拦截 → `block[拦截]`、其余 → `组名[final]`；
4. `route.final` 一律补一条 `节点选择[final]`。

> 与 `plan-flow-v2.md` 的差异：plan 写「DIRECT/block 显示 `DIRECT[直连]` / `block[拦截]`」，
> 但真实配置里往往有多条 `outbound: DIRECT` 的规则（`domain_suffix`、`ip_is_private`、`rs-direct` …），
> 一律叫「直连」会重名合并成一块、丢掉区分度，也让「静态节点名」和「实时兜底名」对不上。
> 因此 v2 把**规则类型放在直连/拦截字样之前**，DIRECT/block 语义改用**颜色 + 次行徽章「直连/拦截」**表达；
> 只有无条件规则才真的显示 `DIRECT[直连]`。

实时侧（`buildFlow`）：

- ③ 先用 `conn.rule` + `conn.rulePayload` 反查静态规则（`rule='rule_set'` 时 `rulePayload` 就是桶名）；
  命不中退化成 `chains[0][rule 类型]`，再不行 `[payload]`，最后 `未知`（配置没读到时的降级）；
- ④⑤ 取 `chains`：`chains[0]` = 分组、`chains[last]` = 节点；单跳（只有节点）时跳过 ④ 直接 ③→⑤；
- DIRECT / block 短路：③ 直接连 ⑥，不画 ④⑤，粒子按 direct 灰 / block 红着色；
- 每条连接落一条 `sample.path`（六段 key），粒子沿它走。

### 2. 图标来源（内联 SVG `<defs><symbol>`）

`flow-anim.html` 顶部 `<defs>` 定义 6 个 16×16 描边 symbol，列头（15×15）与节点块（13×13）都用
`<use href="#ico-…">` 引用，颜色靠 CSS `currentColor`（`fill/stroke` 是继承属性，会渗进 symbol 内部）：

| symbol | 形状 | 用在哪 / 颜色 |
|---|---|---|
| `ico-pc` | 显示器 + 底座 | ①列头 + 电脑块（灰蓝 `#5b7fa6`） |
| `ico-router` | 机身 + 两根天线 + 指示灯 | ②列头 + 路由器块（绿 `--acc`） |
| `ico-rule` | 文档 + 两条列表线 | ③列头 + 规则块（靛 `#4b5aa8`；直连/拦截块改灰/红） |
| `ico-group` | 一个源点分叉到两个点 | ④列头 + 分组块（橙 `#b8720f`） |
| `ico-node` | 双机箱服务器 | ⑤列头 + 节点块（蓝 `--acc2`） |
| `ico-cloud` | 云轮廓 | ⑥列头 + 目标块（青 `#0f8f9a`） |

列头 = 图标 + `① 电脑` + 右上角该列累计次数 + 副标题（`按源 IP` / `sing-box` / `规则集 → 分组` /
`Selector / URLTest` / `出口节点` / `目标`）。

### 3. 结构与流量叠加

- **静态骨架常驻**：③④⑤ 的条目即使 0 流量也渲染（count=0，不显示右侧次数）；config 里没有、实时才出现的
  条目追加在列尾。排序：命中数降序 → config 顺序 → 名称；每列上限 ①6 ②1 ③12 ④8 ⑤10 ⑥10。
- **结构边**：③→④ 由 `rule.group` 指向分组（指向普通节点时直接 ③→⑤）、④→⑤ 由 `group.members` 生成，
  画成**浅色虚线**（`count=0`），与动态边（实线，随条数加粗）区分。
- **零流量时**再补 ①→②、②→③，让「还没有连接」看到的是完整配置拓扑而不是空画布；
  ⑥ 列此时为空（目标只来自实时连接）。
- 顶部统计：活跃连接 / 流动粒子 / 电脑 N 台 / 规则 M 条（config 全量）/ 分组 K 个 / 节点 J 个 /
  命中规则数 / 采样 1.5s；配置通道失败时显示 `⚠ 配置读取失败：…` 并降级成「仅实时」（②列用后端 host）。

### 4. 交互与生命周期

- hover 节点块：该节点与它的**邻居**高亮、其余节点 `opacity .3`；该节点的所有连线换强调色加粗，
  **其它连线 `stroke-opacity` 降到 0.08**；旁边出**自绘 HTML tooltip**（`pre-line` 多行：
  规则条件 / 分组成员 / 节点 server / 连接数），同时保留 `<title>` 兜底。
- 粒子：每条**新出现**的连接一条路径，`requestAnimationFrame` 推进（1.8s 走完，走完淡出），上限 180；
  时间按路径段数均分，段内走与连线同一条三次贝塞尔（`pointOnPath`）。
- 采样：`/connections` 1.5s、`config.json` 30s（`document.hidden` 时两条定时器都跳过）；
  `OnDestroy` 清 `cfgTimer` / `connTimer` / `requestAnimationFrame` / `ResizeObserver` 与粒子数组。
- 几何全部在 `flow-model.buildLayout(flow, size)`（纯数学），组件只负责采样、粒子与 hover 派生状态；
  同一份几何可在 node 里离屏渲染成 SVG 预览（本次实现即用它核对了 1280/900 两档宽度）。

### 5. 文件

| 文件 | 动作 |
|---|---|
| `flow-model.ts` | 重写：`buildStatic` / `buildFlow` / `buildLayout` / `pointOnPath` + 类型（含六列常量、图标表、文本截断） |
| `flow-anim.ts` | 重写：config 30s + connections 1.5s + rAF 粒子 + hover/tooltip，几何改为调用 `buildLayout` |
| `flow-anim.html` | 重写：`<defs>` 六个 symbol、六列列头、节点块（图标 + 标题 + 徽章 + 次数）、虚线结构边、tooltip 层 |
| `styles.css` | 重写 `.flow*` 段：`.ficon` 六色、hover 高亮 / 变淡、结构虚线与强调色、`.flowtip` |
| `docs/plan-flow-anim.md` | 本节 |

### 6. 验收

- `cd web/console && npx ng build --base-href=/edit/` 无 ERROR；
- `npx ngc` + `strictTemplates: true` 无模板类型错误；
- 纯函数自测（tsc 编到 `/tmp` 后 node 跑）：样例 config（`rs-openai → OpenAi` + `final → 节点选择`，
  `OpenAi` 是 2 成员 selector）断言 `buildStatic` 的 rules/groups/nodes 形状；`buildFlow([])` 仍输出
  ③④⑤ 静态节点与 `rule→group`、`group→member` 结构边；4 条实时连接（代理两条 / DIRECT / block）断言
  六段路径、短路四段路径、命中计数与着色；
- 浏览器实测（真实后端 32）：①按源 IP 分多台、③形如 `OpenAi[rs-openai]`、④分组徽章、⑤协议徽章、
  粒子沿六列流动、hover 高亮连线并出 tooltip、切 tab 无泄漏。
