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