# 规划：分组看板（拖拽节点到不同分组）

> 2026-11-21 已实现并上线（commit 见 git log）。前端子代理实现 `group-board`，lead 统一回归/部署/提交。
> 语义沿用既有两通道口径。
>
> 实现补充（lead 在集成时做的两点改进）：
> - 看板/规则面板的 `base` 改成「当前文本」`workDoc()`（原来用原始配置），并把面板提到编辑分支之外，
>   于是**一次拖拽后仍可继续拖**，不必先撤销。
> - 拖入某分组=加入该组（同一节点可同时属于多个组，符合 sing-box 语义）；拖回「未分组」=从所有组移除；
>   拖拽只在「落下真的会改配置」时才高亮可放（分组拖进分组、已在该组、池内拖回池一律不允许）。

## 1. 数据（全部来自已拉取的 config，纯前端解析）

config.json 里：

| 类别 | 位置 | 说明 |
|---|---|---|
| 分组 | `outbounds[].type ∈ {selector, urltest}`，成员在 `outbounds[]`（字符串 tag 数组） | 拖拽目标列 |
| 服务器节点 | `outbounds[]` 里的代理协议（shadowsocks/vmess/vless/trojan/hysteria2/tuic/anytls/socks/masque-client…） | 拖拽源 |
| 分流节点 | `outbounds[]` 里的 `direct` / `block` / `dns` 等特殊出站，以及 `endpoints[]`（masque） | 拖拽源，同样可加入分组 |
| 未分组池 | 不属于任何分组、且不是分组本身的条目 | 独立一列 |

## 2. 交互

- 布局：横向多列——`未分组` + 每个分组一列；列头显示 分组名 / 类型（selector/urltest）/ 成员数 / default。
- 每列内是节点 chip，显示 tag + 协议徽章；`direct/block` 等分流节点用不同底色。
- **拖拽**：HTML5 `draggable` + dragstart/dragover/drop（不引第三方库）。
  - 拖到某分组列 → 加入该分组成员（若已在该组则不重复）。
  - 拖到 `未分组` 列 → 从所有分组中移除。
  - 拖拽时目标列高亮；放下后立即生效到「暂存」。
- 顶部图例：**改分组 = 改 config 结构 → 需重启（约 1s）**；改桶内容才免重启。
- 改动走既有 `enterReview(doc)`：进入暂存 → 顶部黄色横幅 → `应用并重启`。

## 3. 边界

- 分组成员改完若 `default` 不在成员里 → 自动改成第一个成员（与现有 `updateNode`/`deleteNode` 口径一致）。
- 不允许把「分组」拖进「分组」（避免嵌套 selector）。
- 不改变 `route.rules[].outbound` 与 `route.rule_set`（那是「分流规则」面板的事）。

## 4. 文件

| 文件 | 职责 |
|---|---|
| `group-board-model.ts`（新） | 纯函数：`readBoard(doc)`、`moveMember(doc, tag, targetGroup|null)`、`serialize` 复用 config-ops |
| `group-board.ts/.html`（新） | 看板组件，input doc / output docChange |
| `config-pane.ts/.html` | 加「分组看板」按钮，`@if(boardOpen())` 渲染，接 `docChange → enterReview` |
| `styles.css` | 看板与拖拽样式 |

## 5. 验收

- `ng build` 无 ERROR；浏览器实测：拖节点进组 → 出现暂存横幅且 diff 显示成员变化；拖回未分组 → 成员移除；撤销正常；节点表/规则面板无回归。
- 真正应用由用户点「应用并重启」（会重启 sing-box）。