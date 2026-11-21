# 规划 v2：流向图美化（六列：电脑 → 路由器 → 规则集[分组] → 分组 → 节点 → 互联网）

> 2026-11-21 v2 规格（用户要求美化 + 以 config 结构为主、实际流量为辅）。
> 替换 v1 的五列实现（`flow-model.ts` / `flow-anim.*` 可整体重写）。

## 1. 用户明确要求

1. **第一列**：不只一个「我的电脑」——按连接 `metadata.sourceIP` 分解成很多台小电脑，**用小电脑图标**。
2. **第二列**：一个**路由器图标**（sing-box 所在设备）。
3. **第三列**：这一列其实是**规则集**，规则集后面要跟着分组名，形如 **`分组名[规则 tagname]`**（例：`OpenAi[rs-openai]`），配合适图标。
4. **第四列**：分组（每个分组对应很多网络节点）。→ 原「服务器节点组」后移到第四列。
5. 第五列：节点；第六列：互联网云。
6. 结构**优先来自 sing-box config.json 解析**（静态拓扑），再叠加实际连接数据（动态流量）。

## 2. 列定义与数据来源

| 列 | key | 内容 | 来源 |
|---|---|---|---|
| ① | `pc` | 每个 `metadata.sourceIP` 一台小电脑（无则 `本机`），显示 IP 与连接数 | 实时 connections |
| ② | `router` | 单个路由器节点，标签用后端 host（如 `192.168.31.32`）+ 引擎版本 | 后端 + `/version` |
| ③ | `rule` | `分组名[规则 tagname]`：由 config `route.rules[]` 的 `rule_set[].tag` 与 `outbound` 组合；`final` 规则显示 `分组名[final]`；`DIRECT/block` 显示 `DIRECT[直连]` / `block[拦截]` | **config 解析**（静态全量），按实时命中数排序 |
| ④ | `group` | config 里 `outbounds[]` 的 selector/urltest（badge：`手动`/`延迟排序`/`BALANCE`），无流量也显示 | **config 解析** |
| ⑤ | `node` | config 里代理型 outbounds（ss/vmess/vless/trojan/hy2/tuic/anytls/socks/masque…），显示协议徽章 | **config 解析** |
| ⑥ | `cloud` | 实时目标（host/sniffHost/destinationIP 前 10） | 实时 connections |

- 静态拓扑来自 `RouterService.config(backend)` → `parseConfig()`（`config-ops.ts`），只读不改；解析失败时降级为「仅实时」模式并显示小提示。
- 实时叠加：connections 的 `chains` 决定 ④→⑤ 的选择、`rule/rulePayload` 决定 ③ 的命中、`sourceIP` 决定 ①。
- 边：①→②、②→③、③→④、④→⑤、⑤→⑥，按实际出现的关系生成，`count` 为流量条数。

## 3. 视觉

- **图标**：内联 SVG symbol，`<defs>` 里定义 6 个：`ico-pc`（显示器+底座）、`ico-router`（机身+两根天线+指示灯）、`ico-rule`（文档+列表线）、`ico-group`（三个分叉箭头/节点簇）、`ico-node`（服务器机箱/地球针）、`ico-cloud`（云）。
- 每列列头：图标 + 列名 + 副标题（如「按源 IP」「sing-box 路由器」「规则集 → 分组」「Selector / URLTest」「出口节点」「目标」）。
- 节点块：圆角矩形，左侧图标、主标题、次行（徽章/协议/次数），浅色描边；hover 高亮其所有连线，tooltip 显示详情。
- 配色：电脑=灰蓝、路由器=绿、规则集=靛、分组=橙、节点=蓝、云=青；直连灰、block 红。
- 粒子：每条新的「电脑→…→目标」路径上一串小圆点（速度 ~1.6s），路径经过的列依次点亮。

## 4. 性能与生命周期

- config 每 30s 拉一次（结构变化不频繁）；connections 1.5s 采样。
- rAF 只推进粒子；粒子上限 180；`OnDestroy` 清理 interval/rAF/ResizeObserver。
- 宽度自适应（viewBox 跟随容器），列高不足时纵向压缩、超出可滚动。

## 5. 文件

| 文件 | 动作 |
|---|---|
| `flow-model.ts` | 重写：`buildStatic(configText)` + `buildFlow(conns, stat)` → 六列/边/路径 |
| `flow-anim.ts/.html` | 重写渲染与图标；顶部统计增加「电脑 N 台 / 规则 M 条 / 分组 K 个 / 节点 J 个」 |
| `styles.css` | 更新 `.flow*` 样式（图标、hover 高亮、tooltip） |
| `docs/plan-flow-anim.md` | 追加 v2 说明 |

## 6. 验收

- `ng build` 无 ERROR。
- 浏览器实测（真实后端 32）：①多台电脑（按 IP 分列）、②路由器图标、③形如 `OpenAi[rs-openai]`、④分组、⑤节点、⑥目标；粒子沿六列流动；hover 高亮连线；切 tab 无泄漏。
- 零流量时（点「刷新」后立刻切换）显示静态拓扑而非空图。
## 7. 实现记录（2026-11-21 上线）

- 六列已落地：①电脑(按 `sourceIP`，含 IPv6) ②路由器 ③规则集 ④分组 ⑤节点 ⑥互联网；
  统计行显示 `电脑 N 台 / 规则 M 条 / 分组 K 个 / 节点 J 个`，实测 22 台 / 33 条 / 18 个 / 16 个。
- 静态拓扑来自 `/router/config`（30s 刷新），零流量也能看到 ③④⑤ 全量；实时 `/connections`(1.5s) 负责叠加计数与粒子。
- **③ 标签口径修正**：clash 的 `rule` 文本是 `rule_set=rs-openai => route(OpenAi)`，
  不能直接用；新增 `parseRuleText()` 拆出桶名与 `route(…)` 分组名，于是标签就是用户要的
  `分组名[桶名]`：`OpenAi[rs-openai]`、`Bard[bard-domains]`、`📢 谷歌FCM[rs-fcm]`、
  `DIRECT[cn_ip]`、`DIRECT[rs-direct]`（直连/拦截另用颜色与次行徽章表达）。
- 图标：内联 `<symbol>` 六个（ico-pc/router/rule/group/node/cloud），节点块内 `<use>` 复用。
- 性能：粒子上限 180（实测稳定 171-180 在动），config 30s、connections 1.5s，切 tab 全清。
