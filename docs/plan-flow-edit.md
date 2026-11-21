# 规划：流向图可编辑（③ 规则集 / ④ 分组 弹窗编辑 + 全局待保存条）

> 2026-11-21 规格；子代理 `flow-edit` 实现；lead 集成回归部署。
> 不改动 flow-model.ts（布局引擎），只加交互与编辑弹窗。

## 1. 交互

- **点 ③ 规则集卡** → `RuleSetDialog`：
  - 显示该分组当前的 rule_set 引用（chips，可删 ×）。
  - 一个「可用规则集」palette（config `route.rule_set` 全部 tag，含 remote/local），**拖拽** chip 到「已应用」区 = 给该分组加一条/扩展 rule_set 引用；也可点击 + 添加。
  - 删除 = 从该分组的 rule_set 规则里移除该 tag（规则空则删规则）。
  - 任何变化 → 生成新 ConfigDoc → `ConfigDraftService.stage(doc)`。
- **点 ④ 分组卡** → `GroupDialog`：
  - 成员多选：所有代理节点 + 其它分组（可嵌套），checkbox/拖拽排序可选（先做 checkbox）。
  - 分组类型 select：selector / urltest（urltest 显示 url/interval/tolerance 输入）。
  - 变化 → stage(doc)。
- **全局待保存条**（backend-pane 顶部，跨子 tab 可见）：dirty 时显示「已修改 config · 保存并重启 / 取消」。
  - 保存并重启：`RouterService.apply(backend, serialize(draft), expectSha)`（内部备份/check/替换/重启/回滚）→ 成功后清 draft + 刷新。
  - 取消：draft=null。

## 2. 数据/服务

- `ConfigDraftService`(root)：`original`(text+sha)、`draft`(ConfigDoc|null)、`dirty` computed、`stage(doc)`、`cancel()`、`load(backend)`（拉 /router/config）。
- 编辑语义用 config-ops：parseConfig/serializeConfig；规则修改直接操作 root.route.rules / rule_set；分组成员改 outbounds[tag].outbounds、type。
- 新增 rule_set 引用时：优先扩展该分组已有的带 rule_set 的 rule（数组 push）；若无则在 final 之前插入 `{rule_set:[tag], outbound:G}`。
- 删除引用：从对应 rule 的 rule_set 数组移除；空则删该 rule。不删 rule_set 定义本身（桶还在）。

## 3. 文件（仅这些）

config-draft.service.ts / rule-set-dialog.ts/.html / group-dialog.ts/.html /
flow-anim.ts/.html（③④ 节点加 click → output editRule/editGroup）/
backend-pane.ts/.html（挂弹窗 + 待保存条）/ styles.css。
**禁止改 flow-model.ts、config-pane.*、router.service.ts、config-ops.ts。**

## 4. 验收

ng build 无 ERROR；浏览器：点 ③ 卡弹窗、拖/加/删 rs → 待保存条出现 → 取消恢复；点 ④ 卡改成员/类型 → 待保存 → 保存并重启成功（路由 sha 变化、clash 200）→ 条消失。不破坏现有流向渲染/粒子/hover。
## 5. 实现记录（2026-11-21 上线）

- ③/④ 卡片可点（`editable`，cursor:pointer）→ `editRule/editGroup` → backend-pane 弹窗。
- `ConfigDraftService`：baseDoc/originalSha/draft/dirty/stage/cancel/save；save 先 validateDoc+confirm，
  凭据预检（router.credentials）缺凭据→`ssh-cred-dialog`→setCredentials→自动重试；
  apply 乐观锁 expectSha，成功清 draft+重载。
- 规则集弹窗：已应用 chips(✕移除)+palette(拖拽/点＋)；只增删引用不删桶定义；扩展该组已有 rule_set
  规则数组，无则在 final 前插入。分组弹窗：成员 checkbox(节点+其它分组可嵌套)+类型 selector/urltest
  (url/interval/tolerance)；移除成员联动修 default。
- 待保存条 `.draftbar` 跨子 tab：已修改 config + 保存并重启/取消 + 错误文案。
- 实测（甲）：分组勾选→待保存→取消恢复；规则集加 cn_ip→待保存→保存并重启(条消失、无错)→
  移除 cn_ip→再保存恢复；clash 200。乙曾自行掉线（check 通过）已 restart 拉起，与本功能无关。
- 已知限制：`router.setCredentials` 不传 port，弹窗非 22 端口会提示「按 22 保存」；如需自定义端口需要
  给 setCredentials 加参数（另开授权）。

## 6. 分组类型加「负载均衡」预设（2026-11-21）

- 实测：baseline `sing-box check` 通过，但 `loadbalance`/`load-balance`/`balance` 任一种独立类型都
  check 失败 → 该 sing-box(1.15.0-alpha.13) **不支持原生负载均衡**（上游仅 selector/urltest；
  轮询负载均衡为 mihomo/分支特性）。配置里的 BALANCE 实为 urltest。
- 故分组弹窗类型 select 增加第三项「负载均衡（urltest 严格最快·1m）」= 预设：type=urltest +
  tolerance=0 + interval=1m（check 通过）。以 tolerance===0 识别回显为 balance。
- 界面注明：sing-box 无原生轮询负载均衡，此预设以 urltest 严格最快/故障切换近似。
