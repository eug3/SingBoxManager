# 规划：流向动画（五列：我的电脑 → 分流节点 → 分组 → 节点 → 互联网）

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