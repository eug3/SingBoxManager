# 规划：分流规则选择 + 明确「免重启 / 需重启」两通道

> 状态：2026-11-21 规划并派子代理编码（rules-backend / rules-frontend）。
> 本文是设计口径，实现以代码为准。

## 0. 用户确认的语义（正确）

- **分流规则是一个文件**：即 rule-set 桶（`.json` 源 + `.srs` 编译产物）。
- **改规则内容 ≠ 改 config**：改桶内容走 `/publish`，路由 remote rule-set 每 60s 自拉，**不重启**。
- **只有改 config.json 才需要**：动态合成新 config → SSH 推到 OpenWrt → 备份/check/原子替换/重启/健康检查/失败回滚，**重启约 1s**。
- 「动态设置一个 config 通过 SSH 写到 OpenWrt」= 现有 `POST /router/apply`。

## 1. 两通道对照（实现已存在）

| 通道 | 入口 | 写什么 | 生效 | 重启 |
|---|---|---|---|---|
| 规则内容 | `POST /publish` | 存储里的桶 `.json/.srs` | 路由 60s 自拉 | 否 |
| config 结构 | `POST /router/apply` | 路由 `config.json` | 立即（重启） | 是(~1s) |
| 公网入口→规则 | `POST /public/rules/apply` | `route.rule_set[].url` | 立即（重启） | 是(~1s) |

## 2. 本次新增：分流规则选择器（配置页内）

目标：读入 config 后，能**看到并选择**路由规则，且每一步都标清「免重启 / 需重启」。

### 2.1 后端（rules-backend）
- `GET /router/rules?host=`：读 config → 结构化摘要
  - `ruleSets[]`：tag/type/url/path + `contentRestartFree`（remote=true）
  - `routeRules[]`：index/action/outbound/rule_set 引用 + `structural=true`
- 纯函数 `summarizeRules(configText)` + 单测。

### 2.2 前端（rules-frontend）
- `rule-model.ts`：从 ConfigDoc 解析 route.rule_set / route.rules（纯函数）。
- `rule-selector` 组件：
  - route.rules 列表，checkbox 启用/停用（停用=从 route.rules 移除）→ 合成新 config → `docChange` → 进入既有「暂存→应用并重启」流程（**需重启**，有徽章提示）。
  - rule_set 列表徽章：remote→「内容免重启·去规则编辑改」；local→「本地」。
  - 图例：改桶内容=免重启60s；改config结构=需重启。
- 集成进 config-pane 只读视图，按钮「分流规则」。

## 3. 验收
- `go test ./...`、`go vet`、交叉编译通过；`ng build` 无 ERROR。
- 浏览器：配置页→分流规则→停用一条规则→出现「已暂存变更」→应用并重启→路由 route.rules 少一条；改桶内容（规则编辑）不触发重启。
- 集成后由 lead 统一回归 + 提交。
## 4. 顺序控制：↑↓ 调序 + 新建引用按「域名优先 / IP 在后」落位（2026-11-25）

### 4.1 为什么需要
sing-box 的 `route.rules` 是**自上而下第一条命中即停**。TUN 进来时目标还是 IP，
域名靠第 0 条 `action: sniff` 嗅出来 —— 所以一个连接上「域名」和「IP」两个维度同时可用，
**谁排在前面谁先命中**。`cn_ip` / `hk_ip` 这类 IP 桶若排在域名桶之前，解析出的 CN IP
会先命中直连，后面的域名桶永远轮不到（`route.default_domain_resolver` 只用于拨号解析，
不影响匹配顺序；只有 `action: resolve` 会把域名解析成 IP 供后续 IP 规则匹配）。

现网口径（`docs/runbook.md` §2 的 005…175 编号就是这套顺序）：
动作规则（sniff/hijack-dns）→ 私网/单 IP 直连 → **域名桶（005-036）** → rs-node-2/rs-gdirect →
**cn_ip/hk_ip（064/065）** → 后置域名桶（073+，故意让 cn_ip 优先）→ final。

### 4.2 前端（rule-selector + config-ops）
- `config-ops.moveRule(doc, from, to)`：原地移动一条规则（越界抛错）。
- 规则行右侧 `↑ / ↓`：上移=更早命中、下移=更晚命中；每次移动都产出新 `ConfigDoc` →
  「已暂存变更」+ diff → **应用并重启**才生效（改结构，约 1s 断流）。
- 头部连续的**纯动作规则**（`action` 有值且无 outbound / 无桶引用，如 sniff、hijack-dns、resolve）
  钉住不动（`isActionRule`），避免误把嗅探挪到分流之后；行内 `动作` / `IP` 徽章便于对照。
- `validateDoc` 顺带修一个误报：sing-box 内置出站 `direct / block / dns` 无需声明，
  现在不再被当成悬空引用（现网 `ip_is_private → "direct"` 这类规则本来就合法）。

### 4.3 新建引用落位（③ 新建弹窗 / ③ 编辑弹窗）
- `ruleInsertPoint(doc, 'domain' | 'ip')`：只认「IP 桶规则」（引用的桶全是 IP 类，如 cn_ip / hk_ip /
  `rs-ip-*`，判定见 `isIpRuleSetTag`），不认 `ip_is_private` / 单 IP 直连这些安全钉 ——
  域名规则插到**第一条 IP 桶之前**，IP 规则插到**最后一条 IP 桶之后**；没有 IP 桶就落到 final 之前。
- `previewRuleSetRef(...)` 与实际写入 `addRuleSetRef(..., position)` 同口径：
  · `domain`：该出站已有「插入点之前」的规则 → 并入（位置不变）；否则新开一条插到 IP 桶之前；
  · `ip`：已有「插入点之后」的规则 → 并入；否则插到最后一条 IP 桶之后；
  · `auto`：老行为（并入该出站第一条带 rule_set 的规则，否则 final 之前）。
- 弹窗里实时显示落点：「并入 #1（该出站已有的规则，位置不变）」/「插到 #24（cn_ip 之前）」，
  避免盲插。桶名按 `isIpRuleSetTag` 判定（远端 .srs 内容读不到，只能按名字）。

### 4.4 验收（2026-11-25，本地 mock + 无头 Chrome + 落盘 JSON）
- 纯函数 30/30 PASS（esbuild 打包 config-ops 直跑）：桶名判定 11 条、插入点/域插入/并入/
  后置组新开/IP 插入/preview==add/moveRule 边界/内置出站不误报。
- UI：配置页「分流规则」出现 ↑↓ 与 `IP` 徽章；#0 下移后进入 diff（+5/−5 行、待保存）；
  ③ 新建弹窗三档提示正确（`并入 #1` / `插到 #3（cn_ip 之后）` / 跟随现状）；
  选择 DIRECT + domain 落盘为 `#2: ["rs-order-test"] → DIRECT`（在 `#3: cn_ip` 之前），
  选择 ip 落盘为 `#3: ["rs-ip-test"]`（在 cn_ip 之后）；
  ③ 编辑弹窗把 palette 的引用按 `ip` 位置加入（已应用 2→3、待保存条出现）。
