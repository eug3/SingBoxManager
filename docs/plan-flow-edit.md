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

## 7. 列头 ＋ 新建（③ 规则集 / ④ 分组 / ⑤ 节点）+ 配置页简化（2026-11-25）

**用户要求**：流向里规则集/分组/节点标题后面加 ＋ 号可新建，能复用的逻辑就复用；配置标签过于复杂，简化。

### 7.1 列头 ＋

- `flow-model.buildLayout` 给 ③④⑤ 的列头算一个 `add` 按钮几何（13×13 小方块 + 加号 path）：
  紧贴标题末尾（标题宽度按 CJK 1em / 半角 0.56em 估算），右侧给计数 pill 让位；
  ①②⑥（电脑/路由器/互联网）没有新建语义 → `add = null`。实测 1400/1024/900 宽都不与 pill 重叠。
- `flow-anim` 渲染 `.fadd`（SVG `<g role=button>` + `<title>` 提示）并抛出
  `addRule` / `addGroup` / `addNode`；点击先 `stopPropagation`，避免画布「点空白关 ⑤ 弹层」把弹窗收掉。
- `backend-pane` 接收三个事件 → 打开对应新建弹窗，`docChange` 一律 `ConfigDraftService.stage`
  （顶部待保存条，与 ③④ 编辑弹窗同一条链）。

### 7.2 三个新建弹窗（都只产出 `ConfigDoc`，不直接写服务）

| 弹窗 | 内容 | 复用的既有逻辑 |
|---|---|---|
| `rule-set-create-dialog` | tag / 类型 remote·local / format / url·path / update_interval / download_detour / 引用到哪个出站 | `config-ops.addRuleSet` + `addRuleSetRef`；URL 由「现有 remote 桶 URL 前缀 + tag + 扩展名」自动生成；`VaultService.listBuckets()` 查桶是否存在并提示 |
| `group-create-dialog` | tag / 类型（selector、urltest、负载均衡预设）/ urltest 参数 / 成员勾选（含嵌套分组、DIRECT）/ 检索 | `config-ops.addGroup`（tag 重名自动 -2、成员必须存在）；成员列表与 `group-dialog` 同口径 |
| `node-create-dialog` | 两页签：表单（按协议字段）/ 分享链接批量；两者共用「加入分组」 | `node-form.ts`（buildNode/formFromNode/emptyForm）+ `share-link.ts`（parseShareLinks）+ `config-ops.addNode/updateNode` |

- ③ ＋ 必须同时写「定义」和「引用」：流向 ③ 的卡片来自 `route.rules`，只往 `route.rule_set`
  塞定义不会出现在图上（`flow-model.buildStatic` 只按 rules+final 建有向图）。
  引用写法与规则集弹窗一致：该出站已有 rule_set 规则就扩展数组，否则插在 final 兜底规则前。
- 桶文件不在这里建（用户选定方案 A）：只查 `/rule-set/index` 提示「先到规则编辑建桶并发布 .srs，
  否则路由拉取 404」，避免新建完路由日志刷 404。

### 7.3 配置页简化（中度）

- 修掉真 bug：`rule-selector` / `group-board` 原来在只读视图里被渲染两次（`config-pane.html`
  200-207 与 393-400），两套实例各自一份「停用下标集合」，状态会打架；现在只保留一处。
- 工具条从 8 个按钮收成三档：**刷新 / 编辑 JSON / 更多▾**（重启 sing-box、分流规则、分组看板、路由凭据）。
- 节点新增/编辑从页面底部的内联长表单改成 `node-create-dialog`（与流向 ⑤ 同一个组件），
  节点表只留检索框 + 「＋ 新增节点」+ 行内 编辑/删除，页面高度大幅缩短。
- 导入分享链接不再是独立面板，移到节点弹窗的「分享链接导入」页签。
- 顺手修掉一个类名撞车：流向右下角微型图面板的 `.mini` 与节点表小按钮 `button.mini`
  同名，`position:absolute` 把「编辑/删除」吸到页面右下角、表格操作列变空；面板改名
  `.flowmini`（HTML + CSS 5 个选择器），按钮恢复 `position:static` 留在单元格里。

### 7.4 验收（2026-11-25，本地 mock + 无头 Chrome）

- `ng build`（production）通过，仅既有 budget 警告（初始包 528.26 kB / 预算 500 kB；基线是 501.90 kB）。
- 纯函数断言 12/12 PASS（esbuild 打包 config-ops 后直跑）：定义加入、引用插在兜底前、重复 tag 被拒、
  字符串引用归一化成数组、local 缺 path 被拒、新分组追加末尾、重复分组名加 -2、member 不存在被拒等。
- 无头浏览器（mock 8091 + 带 `/router/apply` 正文抓取的代理 8092）实测：
  ① 流向页 3 个 ＋、1400/1024/900 宽均不与计数 pill 重叠；
  ② ③ ＋ 建 `rs-mock-new` → URL 自动成 `http://x/rs-mock-new.srs` → 待保存条 → 保存并重启「✓ 保存成功」，
     落盘 JSON 里出现定义 `{type:remote,tag,format:binary,url,update_interval:1m}` 且引用追加到该组已有 rule_set 数组；
  ③ ④ ＋ 建「🧪 测试组」勾两个节点 → 落盘 `{type:selector,tag,outbounds:[两个节点]}`；
  ④ ⑤ ＋ 表单建 `flow-new-node` 并勾「🚀 节点选择」→ 落盘 outbound + 已加入该组；
  ⑤ ⑤ ＋ 分享链接页签：`ss://` 解析成功、坏 `vmess://` 逐条报错、「导入 N 个」计数正确；
  ⑥ 配置页：工具条只剩 3 个、更多▾ 4 项、分流规则/分组看板各只 1 个实例、节点表检索 6→1 行、
     行内「编辑」弹窗回填 tag/type/已勾 2 组、tag 禁用；配置页新建节点 → 跳到 diff 复核（+8/-0 行）；
  ⑦ 回归：③ 卡片仍开规则集弹窗、⑤ 方格仍弹「激活/测速」固定层。

## 8. ③ 改「一个桶一块」小方块 + 新建桶弹窗（多桶 / 内联分组，2026-11-25）

### 8.1 为什么要改
原来 ③ 是**按出站合并的一张卡**（`组[rs-x +2]`），一个分组只有一张卡：
- 分组名在 ③ 和 ④ 各出现一次，重复；
- 一个分组引用多个桶时看不出来是哪几个桶、各走多少；
- 「给分组配几个桶」只能一个一个建，且分组不存在时还得先去 ④ 建。

用户口径：③ 是「从哪个集合来的流量」→ 应该像 ⑤ 节点一样是**小方块 + 书图标**，一块一个桶。

### 8.2 改动
- `flow-model.ts`：
  - 新增 `StaticRuleTile`（key=`rule:组[桶]`、group/tag/kind/refs/bucket/order/match/tip）与 `buildRuleTiles()`；
  - `StaticRule` 增加 `ruleTags`（一条规则引用的全部桶；logical 递归两层）；
  - `buildFlow` 的 ③ 基线改为 tiles；结构边 ③方块→④卡；`ruleLabelOf` 直接产出 `组[桶]`（与静态 tile 同拼法，实时命中落到对应方块上）；
  - 布局：③ 画 22×22 方块（`G.ruleSquare`）+ 右侧桶名（超长省略），方块可点开 ③ 弹窗；
  - 非桶规则（ip_cidr/port/final…）也占一块，打 `cond` 类（虚线 + 灰）区分；
  - 列头副标题「一个桶一块 · 点开编辑」。
- `rule-set-create-dialog.ts/.html` 重写为「新建桶 · 引用到分组」：
  - **出口**：现有分组下拉，或「＋ 新建一个分组」（tag / selector·urltest / 直接勾成员）；
  - **入口**：现有桶多选（显示「已被引用 ×N / 未引用」）+ 批量新建（逗号/空格分隔，共用 URL 前缀与格式）；
  - 输入里出现的**已存在 tag 自动改成引用**（不再报「已存在」）；
  - 提交写一条 `{rule_set:[a,b,…], outbound:分组}`，落点仍按「域名桶之前 / IP 桶之后」预演；
  - local 类型限制一次一个桶（路径不同）。
- `config-ops.ts`：新增 `addRuleSetRefs(doc, group, tags[], position)`；`addRuleSetRef` 转为单元素委托。
- 文案：③ 列头 ＋ 提示改为「新建桶：可多选/批量建，引用到分组（分组也可新建）」；流向页提示「③ 方块 / ④ 卡片可编辑」。

### 8.3 验收（mock + 无头 Chrome）
- 纯函数 7/7 新增断言全 PASS：多桶插到 cn_ip 之前、并入已有规则、去重/空值、空 tags 抛错、ip 位置插到 IP 桶之后；旧套件（config-ops 12、调序 30）不回归。
- UI：③ 出现书图标小方块（`rs-github`/`rs-msft`/`rs-tg`/`cn_ip`…），点方块打开「③ 规则集 · 组名」弹窗；`final` 等条件块为虚线灰块。
- 新建流程（mock）：出口新建 `SocialNetwork`（selector，2 成员）、勾 `rs-tg`+`rs-netflix`、批量新建 `rs-video, rs-social` → 落盘
  `{rule_set:["rs-tg","rs-netflix","rs-video","rs-social"], outbound:"SocialNetwork"}` 插在 `cn_ip` **之前**，
  两个新桶定义 URL 为 `http://x/rs-video.srs` / `http://x/rs-social.srs`，保存并重启 `✓ 保存成功`。
