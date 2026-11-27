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

## 5. 「规则」子页改为可拖动的规则顺序表（2026-11-25，替换原 GET /rules 只读表）

### 5.1 为什么要改
原「规则」子页只展示 `GET /rules`（运行时只读镜像）：能看真实求值顺序，但**改不了**，
也看不出「这条规则的出口是谁、有没有命中」。用户需要一眼看清「规则 → 出口」并直接拖动调序，
所以把子页主视图换成 **config `route.rules` 顺序表**，运行时表降级为底部折叠区「核对运行态」。

### 5.2 表格（`rule-order.ts / .html`）
| 列 | 内容 |
|---|---|
| `#` | config `route.rules` 下标（= 生效顺序 = 运行时 `/rules` 行号） |
| 匹配条件 | rule_set 引用 chips + 条件摘要；动作规则显示「动作 + 不选路」；`逻辑` / `IP` 徽章 |
| 出口 | `outbound`（DIRECT / 分组名 / direct / block）；动作规则显示动作名（sniff / hijack-dns） |
| 命中 | 当前活动连接命中条数（见 5.4），0 命中的行条件与出口淡化，便于优先核对 |
| 顺序 | 拖动把手 `⋮⋮` + `↑` / `↓` |

- 拖动：整行 `draggable`，`dragover` 按行的上/下半区决定插入到该行之前/之后（亮线提示），
  `drop` 后 `moveRule` 生成新文档 → `ConfigDraftService.stage()` → 顶部待保存条 →「保存并重启」。
- 头部连续的动作规则（`isActionRule`：只有 action、无 outbound / 无桶引用）钉住：不可拖、
  也不允许别的行落到它们前面（插入下标下限 `minMovable`）。
- `move(index, +1)` 的落点必须用「插到下一行之后」，否则「插到下一行之前」再抵消会原地不动（已踩）。

### 5.3 运行态核对（折叠区）
保留原 `GET /rules` 表（`#` / 类型 / payload / 动作），并标注「行号 = 上面表的 #；
动作规则占行不选路；final 不在表内」。重启后两张表逐行一致即说明改动已生效。

### 5.4 命中列的口径（不猜）
`/connections` 的 `rule` 字段是 sing-box 的 `<rule.String()> => <action.String()>`，例如
`rule_set=rs-tg => route(📲 电报信息)`；`route.final` 命中时是字面量 `final`。
前端只能可靠复现**纯 rule_set 规则**的字符串（`rule_set=<tag>` / `rule_set=[a b]`）与
`route(<outbound>)` / `sniff` / `reject` 等动作串，因此 `countRuleHits()`：
- 纯桶规则 + final 精确计数；
- 带 domain / ip_cidr / port 等多条件规则、逻辑规则 → 显示 `—` 并计入「未归类」，
  **不做模糊归并**（宁可显示 —，也不把命中算错行）；
- 同一 `payload+action` 出现多次时取求值顺序上的第一条（与 sing-box 一致）。

### 5.5 验收（2026-11-25 本地 mock + 无头 Chrome）
- 纯函数：`readRuleModel` 新字段（condition / action / payloadHint / actionHint / logical）与
  `countRuleHits` 共 20 条断言全 PASS；顺带修 `rule_set` **字符串写法**被当成「无条件匹配」的旧 bug
  （线上两种写法都有）。
- UI：3 行配置 → 表格 3 行，出口列正确，`cn_ip` 命中 12 / 其它 0 命中标灰，
  底部「命中 12 · final 12 · 0 命中 2 条」；折叠区运行态表可展开（4 行）。
- 拖动第 0 行到末行 → 顺序变化 + 待保存条出现；`↓` 按钮 → 顺序交换 → 保存并重启 → `✓ 保存成功`；
  落盘 `route.rules` 顺序与表格一致（`rs-github` 在前、`rs-tg` 在后）。

## 6. 保存结果的三种形态（2026-11-25，修「已生效却报保存失败」）

现场：保存到 172.16.8.1（乙）时弹窗显示 `✗ 语法校验`，原文
`Http failure response for /router/config?host=172.16.8.1: 0 undefined`，底部还写着「已自动回滚」。
实际上 **status 0 = 浏览器层面的网络失败**（请求没走完，不是 sing-box 语法错），而且这条请求是
`/router/config`——它只在 **apply 成功之后**「重读基准」时才会被调用。旧代码把它一起丢进
`error` → 弹「保存失败」，且未知错误默认落在「语法校验」这一步，误导性很强。

| 形态 | 判定 | 弹窗 |
|---|---|---|
| apply 业务失败（check 不通 / STALE / 回滚） | 99 返回 `{ok:false,error}` | `✗ 保存失败` + 落在真实步骤 + 真实回滚提示 |
| apply 网络失败（status 0 / net::ERR_*） | `isNetworkErr()` | `✗ 保存失败`，标题「与 99 服务的连接中断」，底部「写入结果以路由实际状态为准」，不再谎称已回滚 |
| apply 成功、重读 `/router/config` 失败 | `ConfigDraftService.refreshAfterSave()` 重试 3 次仍失败 | `✓ 保存成功` + ⚠「配置已写回并重启成功，但刷新配置失败（…）：点顶部『刷新』重新读取即可」 |

实现要点：
- `config-draft.service.ts`：`warn` 信号（非致命）+ `refreshAfterSave()`（3 次、退避 0.5s/1.4s），
  重试耗尽后把 `error` 降级进 `warn`，`save()` 仍按成功返回；
- `util.isNetworkErr()`：`Http failure response` / `status 0` / `net::ERR_*` / `timeout`；
- `backend-pane`：`saveWarn` 透传给进度弹窗；网络类错误标题/步骤/底部文案分开；
- `save-progress`：成功态支持 `warn` 行，失败态底部文案改成 `failFoot` 输入（只有真回滚才说回滚）。

验收（本地 mock + 掐链路的 chaos 代理，三种形态各跑一遍）：
1. apply 成功 + 3.2s 内所有 `/router/config` 被掐断 → `✓ 保存成功` + ⚠ 刷新失败警告（原文保留 status 0）；
2. `POST /router/apply` 被掐断 → `✗ 与 99 服务的连接中断` / 失败步骤落在「读取当前配置」/ 底部「以路由实际状态为准」；
3. apply 返回 `sing-box check 未通过` → `✗ 语法校验未通过` / 红叉落在「语法校验」/ 底部「原配置保持不变」。

## 7. 规则拆解与合并（「规则」子页行右键，2026-11-27）

需求：一个出口分组下挂了很多桶，想按「桶」重新分家 —— 把一条规则的多个桶拆成两条，或把两条规则的桶并成一条。
入口：**「规则」子页某行右键 →「⇄ 拆解与合并…」**（没有 rule_set 引用的行项禁用：动作规则 / 纯条件规则不可拆）。
弹层**只针对该行所属的那个出口分组**：只列这个出口下的规则（其它出口不显示），
新建组的出口默认同该出口、也可选别的出口（这一步才是「拆出去」）。

### 7.1 弹窗
- 每组 = **一条引用 rule_set 的 route.rules 条目**，显示 `#下标`、出口、桶 chips；
- 拖 chip 到别的组 = 改引用归属（跨组 = 拆解，两个桶进同一组 = 合并）；
- 每行 `＋ 组` = 在该规则后新增一个空组（新组可选出站）；`✕` = 丢掉这行；
- 弹窗顶部实时预告：`⚠ 保存时会清掉没人指向的分组：…`。

### 7.2 保存口径（`applyRuleGroups` + `pruneOrphanGroups`）
- 有桶的组 → 原地替换该规则的 `rule_set`（保留其它条件与位置）；
- 空组 → 该规则被删；新建但没放桶的组不落盘（「空的组自动消失」）；
- 新增组插在创建它的那条规则之后；未参与的规则（动作/条件/final）原样不动；
- 清理孤儿分组出站：**只清本次涉及的那个出口**（`pruneOrphanGroups(doc, [出口])`），
  别的出口即使没人指向也不动；且**至少保留 1 个分组**；
- 改动走既有「待保存条 → 保存并重启」链路（只改 config，不建桶文件）。

### 7.3 验收（2026-11-27，纯函数 15/15 + mock UI）
- 纯函数：分组读取跳过动作/条件/final；拆解（行数 +1、新组落位、其它规则不动）；合并（行数 −1、桶并集）；
  空新组不落盘；prune 删空组 / 保留被 final 指向的组 / 全空时至少留 1 个。
- UI（2026-11-27 按出口收敛后复测）：右键 `🚀 节点选择` 的规则 → 弹层标题「出口 🚀 节点选择」、
  只列 1 行（`#1 rs-github + rs-msft`），其它出口不出现；＋组 后把 `rs-msft` 拖进新组 → 落盘
  `#1 ["rs-github"]`、`#2 ["rs-msft"]`（同为 🚀 节点选择），6 个分组一个没被误删。
- 早前（未收敛时）记录：右键出现「⇄ 拆解与合并…」→ 弹窗 3 组；`＋ 组` 后拖 `rs-msft` 进新组 → 落盘
  `#1 ["rs-github"]`、`#2 ["rs-msft"]`（插在原规则后）；把 `cn_ip` 拖进 `rs-tg` 组 → 落盘
  `#0 ["rs-tg","cn_ip"] → 📲 电报信息`、原 DIRECT 规则消失；两者均「✓ 保存成功」。

## 8. 配置页「⇧ 格式化」：出站 tag 统一大写 + 引用同步（2026-11-27）

问题背景：sing-box 的 outbound tag 大小写敏感，而两台路由的配置里同时存在 `direct`（小写）
和 `DIRECT`（大写）、`OpenAi`/`Bard`/`SocialNetwork` 这类混合写法 —— 规则里引用哪个是哪个很难看出来，
日志/`/connections` 的代理名也对不上。

### 8.1 用法
配置页 →「编辑 JSON」→ 工具条「⇧ 格式化」→ 看 diff → 「校验」→「应用并重启」。
格式化只改**编辑器里的暂存文本**，不写回路由；写回仍走原来的备份 / check / 重启 / 回滚链路。

### 8.2 口径（`normalizeOutboundTags()`）
- **只动出站 tag**：`outbounds[].tag` 统一 `.toUpperCase()`；中文 / emoji tag 没有大小写，保持原样；
- **引用同步**：`outbounds[].outbounds`（成员）、`outbounds[].default`（selector 默认项）、
  任意层级的 `detour`（http_clients / dns.servers / inbounds / endpoints…）、`route.rules[].outbound`
  （含 `action.outbound`）、`route.final`；
- **撞名处理**：大写后与已有 tag 冲突时 —— 同类型 → 合并（`direct` 并入 `DIRECT`，删掉重复条目，
  引用统一指向保留的那个）；类型不同 → 改名为 `<UP>_2` 并在弹窗里给 warning；
- 成员列表顺带去重、去掉自引用；末尾扫一遍残留旧 tag（排除 `type` 字段）作为提示；
- **不动桶 tag**（`route.rule_set[].tag` 对应 NAS 文件名，改名要同步改文件与 url）；
- **幂等**：已经全大写的配置再点一次只整理缩进，不产生任何 tag 改动。

### 8.3 验收（2026-11-27）
- 纯函数（用两台路由**真配置**做夹具）26 项全 PASS：引用零悬空、改名数 13/14、合并 1 个（direct→DIRECT）、
  改写 90/87 处引用、无重复 tag、成员无重复/无自引用、幂等、`validateDoc` 通过、类型冲突改名 + warning；
- **真实内核校验**：把归一化后的配置拷到 172.16.8.1 与 192.168.31.32，
  `sing-box check`（1.15.0-alpha.13）**两台都通过**（未重启服务，校验后删除临时文件）；
- UI（mock）：配置页 → 编辑 JSON → ⇧ 格式化 → 应用并重启 → 落盘 `tags: DIRECT, OPENAI`，
  规则出口全部改写（`direct`→`DIRECT`、`OpenAi`→`OPENAI`）。

## 9. 配置编辑器高度：撑满窗口剩余高度（2026-11-27）

原来 Monaco 在配置页是固定 `420px`（`monaco-editor` 组件的缺省高度），大屏下浪费空间、小屏下又要滚。
现在编辑视图的编辑器高度按窗口实时算：

- `config-pane` 的 `measureEditor()`：`高度 = min(页脚 footer 顶部, 视口底) - 编辑区顶部 - 44px（动作行）`，下限 240px；
- 进入/退出编辑、窗口 resize 都重算（`scheduleMeasure()` + `resize` 监听），编辑器走 `fill` 模式自动布局；
- 动作行（⇧ 格式化 / 校验 / 应用并重启 / 还原）始终留在页脚之上；矮窗口（≤720p）编辑器缩到能放下的高度，页面仍可滚。

实测（线上 99 + 32 路由真配置）：1400×900 → 474px；1600×1100 → 674px；1280×720 → 294px，三档动作行都在页脚之上；窗口缩放后即时跟随。
