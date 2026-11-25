/**
 * flow-model.ts — 「流向」六列视图的纯函数层（无 Angular / DOM 依赖）。
 *
 * 静态骨架来自 sing-box config.json（`buildStatic`），实时流量来自 clash_api `/connections`
 * （`buildFlow`），六列口径见 docs/plan-flow-v2.md（⑤ 行口径见 v3 说明）：
 *
 *   ① pc     每台源主机（metadata.sourceIP，缺省「本机」）+ 连接数
 *   ② router sing-box 所在设备（单节点，名字由调用方通过 stat.routerName 传入）
 *   ③ rule   规则集条目，形如 `分组名[规则 tag]`（例 `OpenAi[rs-openai]`）
 *   ④ group  selector / urltest 分组（badge：手动 / 延迟排序 / 负载均衡）
 *   ⑤ node   **分组成员逐行列出**：一行 = 一个 (分组, 成员) 对，key 形如 `node:<分组>/<成员>`；
 *            同一个节点属于多个分组时不合并（如 lan-fd-sa 在微软服务/节点选择下各占一行）；
 *            链路里没有分组时落到 `node:-/<节点>` 的「其他」行（排在最后，tooltip 标「无分组」）
 *   ⑥ cloud  一整朵云（只来自实时连接），tooltip 里放目标明细
 *
 * 关键口径：
 *  · ③ 先用 `conn.rule` + `conn.rulePayload` 反查静态规则（`rule='rule_set'` 时 rulePayload 就是
 *    rule_set 的 tag）；命不中时退化成 `chains[0][rule]`（组名 + 规则类型），再不行用 `[payload]`。
 *  · DIRECT / block 短路：③ 直接连 ⑥，不再经过 ④⑤；节点按 direct(灰) / block(红) 着色。
 *  · ⑤ 的行顺序 = ④ 分组顺序（config `outbounds[]` 顺序）+ 组内成员顺序；
 *    ④→⑤ 的边就是「分组 → 它的每个成员」。
 *  · chains 的里外顺序按配置自动判别（首尾谁像节点、谁像分组），两种口径都能落对行。
 *  · 零流量也输出 ③④⑤ 的静态节点（count=0），并用 config 结构补 ③→④、④→⑤ 的静态边。
 */
import { GROUP_TYPES, SPECIAL_TYPES, parseConfig } from './config-ops';
import type { AnyObj } from './config-ops';
import { LAT_LOW, LAT_MID } from './models';
import type { Connection } from './models';

/** 六列（数组顺序即渲染顺序，粒子也按这个方向走） */
export const FLOW_COLS = ['pc', 'router', 'rule', 'group', 'node', 'cloud'] as const;
export type FlowCol = (typeof FLOW_COLS)[number];

/** 节点视觉类别：直连灰 / 代理蓝 / 拦截红 */
export type FlowKind = 'direct' | 'proxy' | 'block';

/**
 * 每列最多展示的条目数。③④⑤ 是结构主体、允许纵向滚动，所以给得很宽；
 * ① 只是源主机分布概览，⑥ 恒为一个大云。
 */
export const FLOW_MAX: Record<FlowCol, number> = { pc: 8, router: 1, rule: 80, group: 48, node: 400, cloud: 1 };

/* ────────────────────────────── 类型 ────────────────────────────── */

/** ③ 规则集条目（一条 route 规则聚合后的展示单元） */
export interface StaticRule {
  /** `rule:` + label，跨列唯一 */
  key: string;
  /** outbound tag（规则指向的分组 / 节点 / DIRECT / block） */
  group: string;
  /** 规则 tag：rule_set 的第一个 tag；无 rule_set 时是匹配条件类型（ip_cidr…）或 'final' */
  ruleTag: string;
  /** 该规则引用的全部桶 tag（tile 一桶一块用；无 rule_set 时为空） */
  ruleTags: string[];
  /** `${group}[${ruleTag}]`，例 `OpenAi[rs-openai]` */
  label: string;
  kind: FlowKind;
  /** 在 config 里的先后顺序（静态排序用） */
  order: number;
  /** 匹配条件摘要（tooltip 用，可能为空串 = 无条件） */
  match: string;
  /** 有多少条 route.rules 聚合到这个 label（同 outbound + 同 rule_set 会合并） */
  refs: number;
}

/** ④ 分组（selector / urltest） */
export interface StaticGroup {
  tag: string;
  /** selector | urltest */
  type: string;
  /** 手动 / 延迟排序 / 负载均衡 */
  badge: string;
  members: string[];
}

/** ⑤ 一行 = 一个 (分组, 成员) 对 */
export interface StaticNodeRow {
  /** `node:<group>/<node>`；group = '-' 表示「其他（无分组）」 */
  key: string;
  /** 所属分组 tag；'-' = 无分组 */
  group: string;
  /** 成员 tag（可能是一个嵌套的子分组） */
  node: string;
  /** 成员是嵌套分组（图标用 group symbol） */
  nested: boolean;
  /** 原始协议（direct / block / shadowsocks …） */
  type: string;
  /** 徽章：协议简写（直连/拦截/组 另标） */
  badge: string;
  /** server:port（没有则为 '—'） */
  server: string;
  kind: FlowKind;
  /** config 里的展开顺序（④ 分组顺序 + 组内成员顺序） */
  order: number;
}

/** 节点登记表（⑤ 行元信息 / 分组 member 查表用） */
export interface StaticNode {
  tag: string;
  /** 原始协议名（shadowsocks / hysteria2 / vless …） */
  type: string;
  kind: FlowKind;
  /** 协议简写徽章（ss / hy2 / vless …） */
  badge: string;
  /** server:port，没有 server 字段时为 '—' */
  server: string;
}

/** config 解析结果（buildStatic 的返回） */
export interface FlowStatic {
  /** 解析成功才为 true；false 时三列结构为空，界面降级成「仅实时」并显示 err */
  ok: boolean;
  err?: string;
  rules: StaticRule[];
  /** ③ 合并后的规则卡（每个出站一张；只用于聚合与兼容，不再直接渲染） */
  cards: StaticRuleCard[];
  /** ③ 实际渲染的小方块：一个桶一块 */
  tiles: StaticRuleTile[];
  groups: StaticGroup[];
  nodes: StaticNode[];
  /** ⑤ 的全部行（④ 分组展开成成员行，含「其他」行） */
  nodeRows: StaticNodeRow[];
}

/** buildFlow 的静态输入：config 解析结果 + ②列显示信息（由组件补） */
export interface FlowStat extends FlowStatic {
  /** ②列主标题（路由 host，如 192.168.31.32） */
  routerName: string;
  /** ②列次行（引擎版本，如 sing-box 1.11.0） */
  routerSub?: string;
}

/** 渲染用的一个节点块 */
export interface FlowNode {
  /** 列前缀 + 名称；⑤ 行是 `node:<分组>/<成员>` */
  key: string;
  /** 主标题原文（渲染层按列宽截断） */
  name: string;
  /** 次行徽章（规则：直连/拦截；分组：手动/延迟排序；节点：协议简写 ss/hy2…） */
  badge: string;
  /** 次行副标题：没有徽章时用它（②列显示引擎版本） */
  sub: string;
  /** 经过该节点的连接数（静态节点可能为 0） */
  count: number;
  kind: FlowKind;
  /** true = 来自 config 的静态条目 */
  stat: boolean;
  /** hover tooltip 的完整描述（多行用 \n） */
  tip: string;
  /** 列内排序权重：静态条目取 config 顺序，实时新条目排在后面 */
  order: number;
  /** ⑤ 行专用：协议（决定图标颜色） */
  proto?: string;
  /** ⑤ 行专用：所属分组（'-' = 无分组） */
  group?: string;
  /** 图标覆盖（⑤ 里嵌套子分组用 group 图标） */
  rowIcon?: string;
  /** 所属横带（band）下标：③④⑤ 都按带排；① ② ⑥ 不用 */
  band?: number;
  /** 末次测速延时（ms）；-1 / undefined = 未测速 */
  lat?: number;
  /** 延时色档（⑤ 成员方格与 ④ 分组卡的聚合点用） */
  latState?: LatState;
  /** true = 最近有活跃连接经过（绿色描边，闲置后自动消失） */
  active?: boolean;
}

/**
 * ③ 的一张「规则卡」：按目标分组（outbound）合并后的展示单元。
 * 一个分组在 config 里可能被多条 route.rules / 多个 rule_set 命中，视图上只画一张卡，
 * label 形如 `🚀 定制[rs-custom ×3]`（同一桶 ×N 条）或 `🚀 定制[rs-custom +2]`（多个桶），
 * 直连/拦截出站合并成 `DIRECT[×3]`。
 */
export interface StaticRuleCard {
  /** `rule:` + label */
  key: string;
  /** 目标出站（= ④ 分组 tag，或 DIRECT / block / 直连节点） */
  group: string;
  /** 合并后的卡片标签 */
  label: string;
  kind: FlowKind;
  /** 在 config 里首次出现的顺序 */
  order: number;
  /** 合并了多少条 route 规则 */
  refs: number;
  /** 明细：每个 rule_set（或匹配类型）的规则条数，tooltip 用 */
  parts: { tag: string; refs: number }[];
  /** 匹配条件摘要（可能为空串） */
  match: string;
}

/**
 * ③ 的一个小方块（书图标）：一个桶 = 一块。
 * 同一个分组引用多个桶时，③ 列里就是多块，各自连到 ④ 那张分组卡；
 * 不是 rule_set 的规则（ip_cidr / port / final…）也占一块，tag 用匹配条件类型。
 */
export interface StaticRuleTile {
  /** `rule:${group}[${tag}]`（与实时侧 ruleLabelOf 的拼法一致，点击靠它反查分组） */
  key: string;
  /** 目标出站（band 归属） */
  group: string;
  /** 桶 tag / 匹配条件类型（ip_cidr、final…） */
  tag: string;
  kind: FlowKind;
  /** 这块背后合并了多少条 route 规则 */
  refs: number;
  /** true = 真桶（rule_set）；false = 非桶条件 */
  bucket: boolean;
  order: number;
  match: string;
  tip: string;
}

/** 路由 DHCP/ARP 名册里的一台局域网客户端（只有同二层有 MAC；EasyTier/IPv6 没有） */
export interface ClientInfo {
  mac: string;
  name: string;
}

/** `GET /router/clients` 的 ip → {mac,name}；由 flow-anim 每 30s 拉一次 */
export type ClientMap = ReadonlyMap<string, ClientInfo>;

/** clash_api /proxies 的「末次测速延时」（ms，key = 出站 tag）；<=0 或缺失 = 未测速 */
export type DelayMap = ReadonlyMap<string, number>;

/**
 * 延时色档（阈值与 util.latClass / models.LAT_LOW=400 / LAT_MID=800 同一套）：
 *  · g    0 < delay <= 400
 *  · y    400 < delay <= 800
 *  · r    delay > 800
 *  · none delay<=0 / 没有测速记录（direct/block/未知）
 */
export type LatState = 'g' | 'y' | 'r' | 'none';

/** 一条横带（band）：一个 ④ 分组 = 一条带；无分组的直连/拦截单独一条置底 */
export interface FlowBand {
  /** 分组 tag；'-' = 直连 / 拦截（无分组） */
  key: string;
  /** 显示名（'-' → 「直连 / 拦截」） */
  label: string;
  kind: FlowKind;
  /** 该带总连接数（⑤ 成员方格计数之和） */
  count: number;
  /** 该带成员方格数 */
  members: number;
  /** 该带 ③ 规则卡片数 */
  rules: number;
  /** 真实分组 tag（'-' 带没有） */
  group?: string;
}

export interface FlowEdge {
  /** `from\u0000to` */
  key: string;
  from: string;
  to: string;
  /** 该方向累积的连接数；0 = 纯结构边（config 拓扑） */
  count: number;
  kind: FlowKind;
  /** true = 来自 config 结构的静态边（渲染成浅色虚线） */
  stat: boolean;
  /** true = 最近有字节增长（渲染成绿色点线 + 流动虚线） */
  active?: boolean;
}

/** 一条连接的列 key 路径（粒子沿它逐列走） */
export interface FlowSample {
  id: string;
  path: string[];
  kind: FlowKind;
}

export interface FlowStats {
  /** 活跃连接数 */
  total: number;
  /** 有流量的源 IP 台数 */
  pcs: number;
  /** config 里的规则条数（静态全量） */
  rules: number;
  /** ③ 合并后的规则卡数（每个出站一张，= 有规则的带数） */
  ruleCards: number;
  /** config 里的分组个数 */
  groups: number;
  /** config 里的节点个数 */
  nodes: number;
  /** ⑤ 的成员方格数（Σ 分组成员，含直连/拦截带） */
  nodeRows: number;
  /** 横带数（分组数 + 可选的直连/拦截带） */
  bands: number;
  /** 本次采样实际命中的规则条目数 */
  hitRules: number;
}

export interface FlowLayout {
  stats: FlowStats;
  /** ① 列的归并口径：mac = 按 MAC 归并（同 MAC 多 IP 合一格），ip = 回落按源 IP */
  pcMode: 'mac' | 'ip';
  /** 横带顺序（= ④ 分组 config 顺序，直连/拦截带在最后） */
  bands: FlowBand[];
  cols: Record<FlowCol, FlowNode[]>;
  edges: FlowEdge[];
  sample: FlowSample[];
  /** 静态结构是否可用（false = 仅实时模式） */
  ok: boolean;
  /** ⑥ 云 tooltip 用的目标明细（按条数降序，前 12） */
  targets: { name: string; count: number }[];
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 宽松取字符串（字符串/数字原样转，其余给空串） */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** 名称比较：代码点序（稳定、与运行环境 locale 无关） */
function cmpName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ────────────────────────────── 节点 key ────────────────────────────── */

export function colOfKey(key: string): FlowCol {
  const i = key.indexOf(':');
  const head = i >= 0 ? key.slice(0, i) : key;
  return (FLOW_COLS as readonly string[]).includes(head) ? (head as FlowCol) : 'pc';
}

export function nameOfKey(key: string): string {
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

export function nodeKey(col: FlowCol, name: string): string {
  return `${col}:${name}`;
}

/** ⑤ 行的 key：`node:<分组>/<成员>`（group='-' 表示无分组） */
export function rowKey(group: string, node: string): string {
  return nodeKey('node', `${group || '-'}/${node}`);
}

/** ⑤ 行 key → {group, node}（渲染/测试用） */
export function splitRowKey(key: string): { group: string; node: string } {
  const name = nameOfKey(key);
  const i = name.indexOf('/');
  if (i < 0) return { group: '-', node: name };
  return { group: name.slice(0, i), node: name.slice(i + 1) };
}

/* ─────────────────────── 名称 → 视觉类别 / 协议徽章 ─────────────────────── */

const DIRECT_NAMES = new Set(['direct', 'direct-out', 'direct-outbound', '直连']);
const BLOCK_NAMES = new Set(['block', 'reject', 'drop', 'blocked', '拦截', 'block-out']);

/** 出站/节点名称 → 视觉类别（DIRECT 灰、block/reject 红、其余蓝） */
export function flowKind(name: string): FlowKind {
  const n = (name ?? '').trim().toLowerCase();
  if (DIRECT_NAMES.has(n)) return 'direct';
  if (BLOCK_NAMES.has(n)) return 'block';
  return 'proxy';
}

/** 视觉类别 → ③列徽章（代理节点不带徽章，靠颜色区分） */
function kindBadge(kind: FlowKind): string {
  return kind === 'direct' ? '直连' : kind === 'block' ? '拦截' : '';
}

/** 协议名 → 徽章简写（config 里出现新协议时原样透传，不会丢信息） */
const PROTO_BADGE: Record<string, string> = {
  shadowsocks: 'ss',
  'shadowsocks-legacy': 'ss',
  shadowsocksr: 'ssr',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria: 'hy',
  hysteria2: 'hy2',
  tuic: 'tuic',
  anytls: 'anytls',
  shadowtls: 'stls',
  socks: 'socks',
  http: 'http',
  ssh: 'ssh',
  tor: 'tor',
  naive: 'naive',
  juicity: 'juicity',
  mieru: 'mieru',
  masque: 'masque',
  wireguard: 'wg',
  direct: '直连',
  block: '拦截',
  dns: 'dns',
};

export function protoBadge(type: string): string {
  const t = (type ?? '').trim().toLowerCase();
  return PROTO_BADGE[t] ?? (t || '?');
}

/** 协议 → 图标配色类（shadowsocks → `p-ss`；未知协议 → `p-other`） */
export function protoTint(type: string): string {
  const t = (type ?? '').trim().toLowerCase();
  return PROTO_BADGE[t] ? `p-${PROTO_BADGE[t]}` : 'p-other';
}

/** 分组徽章：selector→手动、urltest→延迟排序；tag 含 BALANCE/负载/均衡 → 负载均衡 */
export function groupBadge(tag: string, type: string): string {
  if (/balance|负载|均衡/i.test(tag ?? '')) return '负载均衡';
  return type === 'selector' ? '手动' : '延迟排序';
}

/** 组类型猜测（实时链路里出现、config 里没有的组名）：名字带自动/测速算 urltest，其余算 selector */
export function guessGroupBadge(tag: string): string {
  const n = (tag ?? '').toLowerCase();
  if (/urltest|url-test|url_test|auto|自动|延迟|测速|fallback|故障转移/.test(n)) return '延迟排序';
  if (/balance|负载|均衡/.test(n)) return '负载均衡';
  return '手动';
}

/* ─────────────────────── ③ 规则：从 route 段解析条目 ─────────────────────── */

/** 非匹配条件字段（这些键不参与「规则类型」判断） */
const NON_MATCH_KEYS = new Set(['outbound', 'action', 'rule_set', 'type', 'mode', 'rules', 'invert', 'method']);

/** 无出向的动作：不产生流量走向，直接跳过（sniff / DNS 劫持这类不算分流规则） */
const NON_ROUTE_ACTIONS = new Set(['sniff', 'hijack-dns', 'resolve', 'resolve-pre-4_1']);

/** 一条规则引用的全部 rule_set tag（字符串 / 数组；logical 递归两层，与 firstRuleSet 同口径） */
function allRuleSetTags(r: AnyObj, depth = 0): string[] {
  const v = r['rule_set'];
  const out: string[] = [];
  if (typeof v === 'string' && v) out.push(v);
  for (const t of asArray(v).map(str).filter(Boolean)) if (!out.includes(t)) out.push(t);
  if (!out.length && depth < 2) {
    for (const sub of asArray(r['rules'])) {
      const s2 = asObj(sub);
      if (!s2) continue;
      for (const t of allRuleSetTags(s2, depth + 1)) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** rule_set 引用归一化：sing-box 允许字符串或字符串数组，取第一个 tag */
function firstRuleSet(r: AnyObj, depth = 0): string {
  const v = r['rule_set'];
  if (typeof v === 'string' && v) return v;
  const arr = asArray(v).map(str).filter(Boolean);
  if (arr.length) return arr[0];
  if (depth >= 2) return ''; // logical 嵌套只往下看两层，防畸形配置递归
  for (const sub of asArray(r['rules'])) {
    const s = asObj(sub);
    if (!s) continue;
    const t = firstRuleSet(s, depth + 1);
    if (t) return t;
  }
  return '';
}

/** 规则的出向（outbound tag）：outbound 优先，其次 action=reject→block，再次 logical 子规则 */
function outboundOf(r: AnyObj, depth = 0): string {
  const ob = str(r['outbound']);
  if (ob) return ob;
  const action = str(r['action']).toLowerCase();
  if (action === 'reject') return 'block';
  if (action && NON_ROUTE_ACTIONS.has(action)) return '';
  if (action && action !== 'route') return action;
  if (depth >= 2) return '';
  for (const sub of asArray(r['rules'])) {
    const s = asObj(sub);
    if (!s) continue;
    const o = outboundOf(s, depth + 1);
    if (o) return o;
  }
  return '';
}

/** 第一条匹配条件的键名（无 rule_set 时当作「规则类型」，如 domain_suffix / ip_cidr / geoip） */
function firstMatcherKey(r: AnyObj): string {
  for (const k of Object.keys(r)) if (!NON_MATCH_KEYS.has(k)) return k;
  return '';
}

/**
 * 规则 tag：rule_set tag 优先；无 rule_set 时用规则类型（domain_suffix / ip_is_private / geoip …），
 * 这样 `DIRECT[domain_suffix]` 与 `DIRECT[ip_is_private]` 不会因为都叫「直连」而合并。
 * 连匹配条件都没有（无条件规则）时：直连→'直连'、拦截→'拦截'、其余→'final'。
 */
function ruleTagOf(r: AnyObj, group: string): string {
  const rs = firstRuleSet(r);
  if (rs) return rs;
  const matcher = firstMatcherKey(r);
  if (matcher) return matcher;
  return 'final';
}

/** 匹配条件摘要（tooltip 用）：标量/短数组直出，长清单截断 */
function listText(v: unknown): string {
  if (Array.isArray(v)) {
    const items = asArray(v).map(str).filter(Boolean);
    if (!items.length) return '';
    const head = items.slice(0, 2).map((s) => (s.length > 24 ? s.slice(0, 24) + '…' : s));
    return head.join('、') + (items.length > 2 ? ` …共${items.length}项` : '');
  }
  if (typeof v === 'string') return v.length > 28 ? v.slice(0, 28) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function matchSummary(r: AnyObj): string {
  const parts: string[] = [];
  const rs = firstRuleSet(r);
  if (rs) parts.push(`rule_set=${rs}`);
  for (const k of Object.keys(r)) {
    if (k === 'rule_set' || k === 'outbound' || k === 'action') continue;
    const txt = listText(r[k]);
    if (txt) parts.push(`${k}=${txt}`);
  }
  return parts.join(' · ');
}

/* ─────────────────────── 节点 server:port ─────────────────────── */

function serverOf(o: AnyObj): string {
  const host = str(o['server']);
  if (!host) return '—';
  const port = str(o['server_port']);
  return port ? `${host}:${port}` : host;
}

/* ────────────────────────────── buildStatic ────────────────────────────── */

/** 空静态结构（配置还没拉到时用；ok=false 会让界面提示「仅实时」） */
export function emptyStatic(routerName = 'sing-box', routerSub = ''): FlowStat {
  return { ok: false, rules: [], cards: [], tiles: [], groups: [], nodes: [], nodeRows: [], routerName, routerSub };
}

/**
 * 解析整份 sing-box config.json → ③④⑤ 三列的结构。
 * 只读，不改任何东西；JSON 坏掉/不是对象时返回 ok=false + 中文 error，不抛。
 */
export function buildStatic(configText: string): FlowStatic {
  const empty = (err: string): FlowStatic => ({
    ok: false,
    err,
    rules: [],
    cards: [],
    tiles: [],
    groups: [],
    nodes: [],
    nodeRows: [],
  });
  const text = (configText ?? '').trim();
  if (!text) return empty('配置为空');

  let root: AnyObj;
  try {
    root = parseConfig(text).root;
  } catch (e) {
    return empty(`配置解析失败：${(e as Error)?.message ?? String(e)}`);
  }

  const outbounds = asArray(root['outbounds'])
    .map(asObj)
    .filter((o): o is AnyObj => !!o);
  const endpoints = asArray(root['endpoints'])
    .map(asObj)
    .filter((o): o is AnyObj => !!o);
  const all = [...outbounds, ...endpoints];

  /** 全部 tag → 条目（含分组、direct/block，⑤ 行要查成员元信息） */
  const byTag = new Map<string, AnyObj>();
  for (const o of all) {
    const tag = str(o['tag']);
    if (tag && !byTag.has(tag)) byTag.set(tag, o);
  }

  // ── ④ 分组：outbounds 里 type ∈ {selector, urltest} ──
  const groups: StaticGroup[] = [];
  const groupTags = new Set<string>();
  for (const o of outbounds) {
    const type = str(o['type']);
    if (!GROUP_TYPES.has(type)) continue;
    const tag = str(o['tag']) || '?';
    if (groupTags.has(tag)) continue;
    groupTags.add(tag);
    groups.push({
      tag,
      type,
      badge: groupBadge(tag, type),
      members: asArray(o['outbounds']).map(str).filter(Boolean),
    });
  }

  // ── ⑤ 节点登记表（代理出站，含 endpoints）：计数与「是不是节点」的口径 ──
  const nodes: StaticNode[] = [];
  const nodeTags = new Set<string>();
  for (const o of all) {
    const type = str(o['type']);
    if (GROUP_TYPES.has(type) || SPECIAL_TYPES.has(type)) continue;
    const tag = str(o['tag']) || '?';
    if (nodeTags.has(tag)) continue;
    nodeTags.add(tag);
    nodes.push({ tag, type, kind: 'proxy', badge: protoBadge(type), server: serverOf(o) });
  }
  const nodeByTag = new Map(nodes.map((n) => [n.tag, n]));

  /** ⑤ 行元信息用「全部出站」名册：direct/block/endpoints 也可能是分组成员，要能列出协议与 server */
  const rowMeta = (tag: string): { type: string; badge: string; server: string; kind: FlowKind } | null => {
    const o = byTag.get(tag);
    if (!o) return null;
    const type = str(o['type']);
    const kind = flowKind(tag) !== 'proxy' ? flowKind(tag) : SPECIAL_TYPES.has(type) ? flowKind(tag) : 'proxy';
    return { type, badge: protoBadge(type), server: serverOf(o), kind };
  };

  // ── ⑤ 行：④ 分组按 config 顺序展开成成员行（同一节点属于多组 → 多行，不合并） ──
  const nodeRows: StaticNodeRow[] = [];
  const rowSeen = new Set<string>();
  const pushRow = (group: string, node: string): void => {
    const key = rowKey(group, node);
    if (rowSeen.has(key)) return; // 同一分组里重复列同一个成员只留一行（config 冗余）
    rowSeen.add(key);
    const nested = groupTags.has(node);
    const meta = rowMeta(node);
    // 成员一律成行：哪怕 tag 在 config 里查不到（脏引用）也占一行，保证「行数 = 成员数」，
    // 只是协议/server 显示成 '?' / '—'，一眼能看出配置有问题。
    const type = nested ? 'group' : (meta?.type ?? '?');
    const kind: FlowKind = nested ? 'proxy' : (meta?.kind ?? 'proxy');
    nodeRows.push({
      key,
      group,
      node,
      nested,
      type,
      badge: nested ? '组' : kind === 'direct' ? '直连' : kind === 'block' ? '拦截' : meta ? protoBadge(type) : '?',
      server: nested ? '—' : (meta?.server ?? '—'),
      kind,
      order: nodeRows.length,
    });
  };
  for (const g of groups) for (const m of g.members) pushRow(g.tag, m);

  // ── ③ 规则：route.rules[] + route.final ──
  const rules: StaticRule[] = [];
  const byLabel = new Map<string, StaticRule>();
  const addRule = (group: string, ruleTag: string, match: string, tags: string[] = []): void => {
    if (!group) return;
    const label = `${group}[${ruleTag}]`;
    const hit = byLabel.get(label);
    if (hit) {
      hit.refs++;
      if (!hit.match && match) hit.match = match;
      for (const t of tags) if (!hit.ruleTags.includes(t)) hit.ruleTags.push(t);
      return;
    }
    const rule: StaticRule = {
      key: nodeKey('rule', label),
      group,
      ruleTag,
      ruleTags: [...tags],
      label,
      kind: flowKind(group),
      order: rules.length,
      match,
      refs: 1,
    };
    byLabel.set(label, rule);
    rules.push(rule);
  };

  const route = asObj(root['route']);
  asArray(route?.['rules']).forEach((item) => {
    const r = asObj(item);
    if (!r) return;
    const group = outboundOf(r);
    if (!group) return; // sniff / hijack-dns 之类不产生分流走向
    addRule(group, ruleTagOf(r, group), matchSummary(r), allRuleSetTags(r));
    // 出站不是分组（DIRECT / block / 直连节点）→ 在「直连 / 拦截」带里占一格，③→④→⑤ 才走得通
    if (!groupTags.has(group)) pushRow('-', group);
  });

  // final：没有 rule_set，label 形如 `节点选择[final]`
  const finalTag = str(route?.['final']);
  if (finalTag) {
    addRule(finalTag, 'final', '未命中任何规则时的兜底出站');
    if (!groupTags.has(finalTag)) pushRow('-', finalTag);
  }

  return {
    ok: true,
    rules,
    cards: mergeRuleCards(rules, (g) => groupTags.has(g)),
    tiles: buildRuleTiles(rules),
    groups,
    nodes,
    nodeRows,
  };
}

/* ────────────────────────────── 连接侧辅助 ────────────────────────────── */

/** 连接元信息（models.ts 的 metadata 没声明 sourceIP/sourcePort，这里按实际应答补一份） */
type ConnMeta = NonNullable<Connection['metadata']> & {
  sourceIP?: string;
  sourcePort?: string;
  sourceGeoIP?: string[] | null;
};

function metaOf(c: Connection): ConnMeta {
  return (c.metadata ?? {}) as ConnMeta;
}

function chainsOf(c: Connection): string[] {
  return asArray(c.chains)
    .map(str)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 连接终点标签（⑥ 云 tooltip 里的目标名）：host / sniffHost / destinationIP，最多 40 字 */
export function destLabel(c: Connection): string {
  const m = metaOf(c);
  const raw = (m.host || m.sniffHost || m.destinationIP || '').trim();
  if (!raw) return '未知目标';
  return raw.length > 40 ? raw.slice(0, 39) + '…' : raw;
}

/** 源主机名（①列节点名）：metadata.sourceIP，缺省「本机」 */
export function sourceLabel(c: Connection): string {
  const ip = (metaOf(c).sourceIP ?? '').trim();
  return ip || '本机';
}

/**
 * 一条连接 → {节点, 分组}。
 *
 * sing-box 的 `chains` 里外顺序在不同版本/口径下不一致（常见 clash 口径是 `[组..., 节点]`，
 * 也有 `[节点, 组...]` 由内向外），这里用配置里的 tag 名册给两种口径打分，谁像就按谁解析：
 *  · 首/尾谁在节点名册里（或 DIRECT/block 这类出站）、谁在分组名册里；
 *  · 打平（配置读不到）时按由内向外口径取 `chains[0]` 为节点、`chains[last]` 为最外层分组。
 */
export function resolveChain(chains: readonly string[], stat: FlowPick): { node: string; group: string } {
  const t = chains.map((s) => (s ?? '').trim()).filter(Boolean);
  if (!t.length) return { node: '', group: '' };
  if (t.length === 1) return { node: t[0], group: '' };

  const groupSet = new Set(stat.groups.map((g) => g.tag));
  const nodeSet = new Set(stat.nodes.map((n) => n.tag));
  const isGroup = (s: string): boolean => groupSet.has(s);
  const isNode = (s: string): boolean => nodeSet.has(s) || flowKind(s) !== 'proxy';

  const first = t[0];
  const last = t[t.length - 1];
  // A：clash 常见口径 —— 前面是分组链、末位是真实出站
  const scoreA = (isGroup(first) ? 2 : 0) + (isNode(last) ? 2 : 0);
  // B：由内向外口径 —— 首位是真实出站、末位是最外层分组
  const scoreB = (isNode(first) ? 2 : 0) + (isGroup(last) ? 2 : 0);
  return scoreA > scoreB ? { node: last, group: first } : { node: first, group: last };
}

/** resolveChain 只需要 ④⑤ 的名册 */
type FlowPick = Pick<FlowStatic, 'groups' | 'nodes'>;

/** 一条连接命中的规则标签：静态反查优先，命不中按 `组名[规则类型]` 兜底 */
/** 从 clash 的 rule 文本里拆出 rule_set 桶名与 route(…) 分组名
 *  例：'rule_set=rs-openai => route(OpenAi)' → { bucket:'rs-openai', group:'OpenAi' }
 *      'final => route(🐟 漏网之鱼)'        → { group:'🐟 漏网之鱼' }
 *      'domain_suffix=netflix.com'          → { matcher:'domain_suffix' } */
function parseRuleText(rule: string): { bucket?: string; group?: string; matcher?: string } {
  const t = (rule ?? '').trim();
  if (!t) return {};
  const out: { bucket?: string; group?: string; matcher?: string } = {};
  const mRoute = /route\(\s*([^)]+?)\s*\)/i.exec(t);
  if (mRoute) out.group = mRoute[1];
  const mSet = /rule_set\s*=\s*([^=<>\s]+)/i.exec(t);
  if (mSet) {
    out.bucket = mSet[1];
    return out;
  }
  if (/^final\b/i.test(t)) return out;
  const mMatcher = /^([a-z_]+)\s*=/i.exec(t);
  if (mMatcher) out.matcher = mMatcher[1];
  return out;
}

function ruleLabelOf(
  c: Connection,
  chains: string[],
  stat: FlowStat,
  byRuleTag: Map<string, StaticRule>,
): { label: string; kind: FlowKind; hit?: StaticRule } {
  const ruleText = (c.rule ?? '').trim();
  const payload = (c.rulePayload ?? '').trim();
  const parsed = parseRuleText(ruleText);
  // chains 由内向外：chains[0]=出口节点，最外层分组在链尾
  const outerGroup = chains.length >= 2 ? chains[chains.length - 1] : '';
  const nodeTag = chains.length ? chains[0] : '';
  const kind = flowKind(nodeTag || outerGroup);

  // rule_set 规则：桶名可能写在 rule 文本里（rule_set=rs-x => route(...)），
  // 也可能 —— 且仅当 rule 类型就是 'rule_set' 时 —— 才在 rulePayload 里。
  // 其它规则类型的 rulePayload 是匹配值（如 domain_suffix 的 '.cn'），绝不能当桶名。
  const bucket =
    parsed.bucket ?? (ruleText === 'rule_set' && payload && !payload.includes('=') ? payload : '');
  const hit = bucket ? byRuleTag.get(bucket) : undefined;
  // 出站（= ③ 卡片的归属）：静态命中用 config 里的 outbound，否则从 rule 文本 / chains 推
  const group = hit?.group || parsed.group || outerGroup || nodeTag || 'DIRECT';
  const outKind: FlowKind = hit ? (hit.kind === 'proxy' ? kind : hit.kind) : kind;
  // ③ 视图是「按出站合并的一张卡」：命中同一出站的所有 rule_set 都落到同一张卡上
  // ③ 一个桶一块：直接用 `分组[桶]` 作为 key（与静态 tile 同拼法）；非桶规则回落匹配类型
  // tag 优先桶名，其次 rule 文本里的匹配类型，再次 rule 类型本身（与 buildStatic 的 ruleTagOf 对齐）
  const tag = bucket || parsed.matcher || (ruleText && ruleText !== 'rule_set' ? ruleText : '') || (stat.ok ? 'final' : '未知');
  return { label: `${group}[${tag}]`, kind: outKind };
}

/** 规则集 → ③ 小方块（一桶一块；非桶规则也占一块，tag 用匹配条件类型） */
function buildRuleTiles(rules: StaticRule[]): StaticRuleTile[] {
  const out: StaticRuleTile[] = [];
  const byKey = new Map<string, StaticRuleTile>();
  for (const r of rules) {
    const tags = r.ruleTags.length ? r.ruleTags : [r.ruleTag];
    for (const tag of tags) {
      const key = nodeKey('rule', `${r.group}[${tag}]`);
      const hit = byKey.get(key);
      if (hit) {
        hit.refs += r.refs;
        if (!hit.match && r.match) hit.match = r.match;
        continue;
      }
      const tip = [
        `${r.ruleTags.length ? '规则集' : '匹配条件'} ${tag}`,
        `出站 ${r.group}`,
        r.match ? `条件 ${fitText(r.match, 60)}` : '',
        r.refs > 1 ? `合并了 ${r.refs} 条 route 规则` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const tile: StaticRuleTile = {
        key,
        group: r.group,
        tag,
        kind: r.kind,
        refs: r.refs,
        bucket: r.ruleTags.length > 0,
        order: r.order,
        match: r.match,
        tip,
      };
      byKey.set(key, tile);
      out.push(tile);
    }
  }
  out.sort((a, b) => a.order - b.order || cmpName(a.tag, b.tag));
  return out;
}

/** ③ 卡片标签：同一桶 → `组[桶 ×N]`；多个桶 → `组[主桶 +K]`；直连/拦截带 → `DIRECT[×N]` */
function ruleCardLabel(prefix: string, parts: { tag: string; refs: number }[], refs: number): string {
  if (parts.length === 1) return `${prefix}[${parts[0].tag} ×${refs}]`;
  return `${prefix}[${parts[0].tag} +${parts.length - 1}]`;
}

/**
 * 把细粒度规则（一个出站 + 一个 rule_set 一条）合并成「每带一张卡」：
 *  · 普通分组：按出站分组，label 形如 `🚀 定制[rs-custom ×3]` / `🚀 定制[rs-custom +2]`；
 *  · 直连/拦截带（出站不是分组）：整带合并成一张，前缀取规则最多的那个出站（`DIRECT[×5]`），
 *    明细（DIRECT ×3 / block ×1 …）放 tooltip —— 这样 ③ 与 ④ 每条带都是 1:1。
 */
function mergeRuleCards(rules: StaticRule[], isGroup: (g: string) => boolean): StaticRuleCard[] {
  const byBand = new Map<string, StaticRule[]>();
  for (const r of rules) {
    const k = isGroup(r.group) ? r.group : '-';
    const list = byBand.get(k);
    if (list) list.push(r);
    else byBand.set(k, [r]);
  }
  const cards: StaticRuleCard[] = [];
  for (const [bandKey, list] of byBand) {
    const refs = list.reduce((n, r) => n + r.refs, 0);
    const direct = bandKey === '-';
    // 直连带：前缀取规则条数最多的出站（DIRECT / block / REJECT…）
    const prefix = direct
      ? [...list.reduce((m, r) => m.set(r.group, (m.get(r.group) ?? 0) + r.refs), new Map<string, number>())]
          .sort((a, b) => b[1] - a[1] || cmpName(a[0], b[0]))[0][0]
      : bandKey;
    const parts = direct
      ? [...list.reduce((m, r) => m.set(r.group, (m.get(r.group) ?? 0) + r.refs), new Map<string, number>())]
          .map(([tag, n]) => ({ tag, refs: n }))
          .sort((a, b) => b.refs - a.refs || cmpName(a.tag, b.tag))
      : [...list.reduce((m, r) => m.set(r.ruleTag, (m.get(r.ruleTag) ?? 0) + r.refs), new Map<string, number>())]
          .map(([tag, n]) => ({ tag, refs: n }))
          // 桶按条数降序；条数相同先排真桶、把兜底的 `final` 放最后（别让主标签变成 final）
          .sort(
            (a, b) =>
              b.refs - a.refs ||
              (a.tag === 'final' ? 1 : 0) - (b.tag === 'final' ? 1 : 0) ||
              cmpName(a.tag, b.tag),
          );
    // 直连/拦截带：不管里面有几个出站，标签统一 `DIRECT[×N]`，明细在 tooltip
    const label = direct ? `${prefix}[×${refs}]` : ruleCardLabel(prefix, parts, refs);
    cards.push({
      key: nodeKey('rule', label),
      group: bandKey,
      label,
      kind: flowKind(prefix),
      order: list[0].order,
      refs,
      parts,
      match: list.map((r) => r.match).filter(Boolean).join('；'),
    });
  }
  cards.sort((a, b) => a.order - b.order || cmpName(a.label, b.label));
  return cards;
}

/* ────────────────────────────── 合流 ────────────────────────────── */

/** 实时计数条目 */
interface DynInfo {
  count: number;
  kind: FlowKind;
  badge?: string;
  tip?: string;
  /** ⑤ 行专用：链路中间的分组（如 BALANCE），tooltip 里显示成「经由」 */
  mid?: string;
}

function bumpDyn(map: Map<string, DynInfo>, key: string, kind: FlowKind, badge?: string): DynInfo {
  const hit = map.get(key);
  if (hit) {
    hit.count++;
    return hit;
  }
  const info: DynInfo = { count: 1, kind, badge };
  map.set(key, info);
  return info;
}

/**
 * 静态基线 + 实时计数 → 一列节点：
 *  · 静态条目即使 0 流量也保留（order 保持 config 顺序）；
 *  · 实时出现、config 里没有的条目追加在后面（order 从 1000 起）；
 *  · 排序：`byCount` 时命中数降序 → config 顺序 → 名称；否则纯 config 顺序（⑤ 行必须保持结构顺序）。
 */
function mergeCol(base: FlowNode[], dyn: Map<string, DynInfo>, max: number, byCount = true): FlowNode[] {
  const byKey = new Map<string, FlowNode>();
  for (const n of base) byKey.set(n.key, { ...n, count: 0 });

  let extra = 0;
  for (const [key, d] of dyn) {
    const hit = byKey.get(key);
    if (hit) {
      hit.count = d.count;
      if (d.kind !== 'proxy') hit.kind = d.kind;
      // 基线条目的徽章/副标题/tooltip 都以 config 为准（信息更全），实时侧只补计数与 kind
      if (d.badge && !hit.badge) hit.badge = d.badge;
      continue;
    }
    const name = nameOfKey(key);
    byKey.set(key, {
      key,
      name,
      badge: d.badge ?? '',
      sub: '',
      count: d.count,
      kind: d.kind,
      stat: false,
      tip: d.tip ?? name,
      order: 1000 + extra++,
    });
  }

  const list = [...byKey.values()];
  list.sort((a, b) => (byCount ? b.count - a.count || a.order - b.order : a.order - b.order) || cmpName(a.name, b.name));
  return list.slice(0, max);
}

/* ────────────────────────────── buildFlow ────────────────────────────── */

/**
 * 连接列表 + 静态结构 → 六列布局。
 *
 * @param conns clash_api /connections 的 connections 数组
 * @param stat  buildStatic 的结果 + ②列名字；配置读不到时传 emptyStatic()
 */
export function buildFlow(
  conns: Connection[],
  stat: FlowStat,
  clients?: ClientMap,
  delays?: DelayMap,
  activeEdges?: ReadonlySet<string>,
  activeNodes?: ReadonlySet<string>,
): FlowLayout {
  const routerName = stat.routerName || 'sing-box';
  const routerKey = nodeKey('router', routerName);
  const cloudKey = nodeKey('cloud', '互联网');

  // 静态索引（反查 / 补徽章用）
  const byRuleTag = new Map<string, StaticRule>();
  for (const r of stat.rules) if (!byRuleTag.has(r.ruleTag)) byRuleTag.set(r.ruleTag, r);
  const groupByTag = new Map(stat.groups.map((g) => [g.tag, g]));
  /** 出站 → ③ 合并卡（同一出站的多条规则/多个 rule_set 共用一张卡；
      出站不是分组时共用「直连 / 拦截」那张卡） */
  const cardByBand = new Map(stat.cards.map((c) => [c.group, c]));
  const cardOf = (group: string): StaticRuleCard | undefined =>
    cardByBand.get(group) ?? (groupByTag.has(group) ? undefined : cardByBand.get('-'));
  const nodeByTag = new Map(stat.nodes.map((n) => [n.tag, n]));
  const rowByTag = new Map<string, StaticNodeRow>();
  for (const r of stat.nodeRows) rowByTag.set(`${r.group}\u0000${r.node}`, r);

  /** ① 聚合：key = `pc:<mac>`（有 MAC）或 `pc:<ip>`（无 MAC 回落），同 key 的连接合并成一块 */
  interface PcAgg {
    count: number;
    ips: Set<string>;
    mac: string;
    name: string;
  }
  const pcAgg = new Map<string, PcAgg>();
  let pcUsedMac = false;
  const ruleDyn = new Map<string, DynInfo>();
  const groupDyn = new Map<string, DynInfo>();
  const rowDyn = new Map<string, DynInfo>();
  const targetDyn = new Map<string, number>();
  const edges = new Map<string, FlowEdge>();
  const sample: FlowSample[] = [];
  let total = 0;

  /** ⑤ 行 key：优先落到 config 里那行；分组存在但成员没列上 → 动态补一行 */
  const rowOf = (group: string, node: string): string => rowKey(group || '-', node);

  const addEdge = (from: string, to: string, kind: FlowKind): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    const e = edges.get(key);
    if (e) {
      e.count++;
      e.stat = false;
      return;
    }
    edges.set(key, { key, from, to, count: 1, kind, stat: false });
  };

  for (const c of conns ?? []) {
    const chains = chainsOf(c);
    const hitChain = resolveChain(chains, stat);
    const src = sourceLabel(c);
    const dest = destLabel(c);
    const { label, kind: ruleKind, hit } = ruleLabelOf(c, chains, stat, byRuleTag);
    const outKind = flowKind(hitChain.node || chains[chains.length - 1] || '');
    // 只有「完全没有链路」时才跳过 ④⑤ 直接连云；DIRECT / block 走「直连 / 拦截」带
    const shortCircuit = !chains.length;

    // ① 按 MAC 归并：同 MAC 的多个 IP 合并成一块；名册里没有（EasyTier/IPv6/接口不可用）回落 sourceIP
    const cli = clients?.get(src);
    const pcKey = cli?.mac ? nodeKey('pc', cli.mac) : nodeKey('pc', src);
    if (cli?.mac) pcUsedMac = true;
    const pcHit = pcAgg.get(pcKey);
    if (pcHit) {
      pcHit.count++;
      if (src) pcHit.ips.add(src);
      if (!pcHit.name && cli?.name) pcHit.name = cli.name;
    } else {
      pcAgg.set(pcKey, { count: 1, ips: new Set(src ? [src] : []), mac: cli?.mac ?? '', name: cli?.name ?? '' });
    }

    const entries: { col: FlowCol; key: string }[] = [
      { col: 'pc', key: pcKey },
      { col: 'router', key: routerKey },
      { col: 'rule', key: nodeKey('rule', label) },
    ];
    const kind: FlowKind = shortCircuit ? ruleKind : outKind;
    // 链路中间的分组（node 与最外层分组之间，如 BALANCE）→ 行 tooltip 的「经由」
    const mids = chains.length > 2 ? chains.slice(1, -1) : [];
    let group = '';
    let nodeRow = '';
    if (!shortCircuit) {
      group = hitChain.group || '-';
      nodeRow = rowOf(group, hitChain.node);
      entries.push({ col: 'group', key: nodeKey('group', group) });
      entries.push({ col: 'node', key: nodeRow });
    }
    entries.push({ col: 'cloud', key: cloudKey });

    // 计数
    total++;
    bumpDyn(ruleDyn, entries[2].key, ruleKind, kindBadge(ruleKind));
    if (!shortCircuit) {
      if (group) {
        const g = groupByTag.get(group);
        bumpDyn(groupDyn, nodeKey('group', group), 'proxy', group === '-' ? '无分组' : (g?.badge ?? guessGroupBadge(group)));
      }
      const info = bumpDyn(rowDyn, nodeRow, 'proxy');
      if (mids.length && !info.mid) info.mid = mids.join(' › ');
      if (!info.tip) {
        const meta = nodeByTag.get(hitChain.node);
        const row = rowByTag.get(`${group || '-'}\u0000${hitChain.node}`);
        info.tip = [
          `节点 ${hitChain.node}`,
          `协议 ${meta?.type ?? row?.type ?? '—'}`,
          `服务器 ${meta?.server ?? row?.server ?? '—'}`,
          `所属分组 ${group || '无分组'}`,
        ].join('\n');
      }
      // 命中规则的匹配条件补进 tooltip（只补一次）
      if (hit) {
        const infoRule = ruleDyn.get(entries[2].key);
        if (infoRule && !infoRule.tip) infoRule.tip = `规则 ${label}${hit.match ? '\n' + hit.match : ''}`;
      }
    }
    targetDyn.set(dest, (targetDyn.get(dest) ?? 0) + 1);

    // 边（相邻两列）
    for (let i = 0; i < entries.length - 1; i++) addEdge(entries[i].key, entries[i + 1].key, kind);
    sample.push({
      id: c.id ?? `${src}>${dest}#${sample.length}`,
      path: entries.map((e) => e.key),
      kind,
    });
  }

  /* ── 横带（band）：④ 分组按 config 顺序各一条；无分组的出站汇总成「直连 / 拦截」带置底 ──
     · 分组：config 里的 selector/urltest，顺序即 ④ 列顺序；
     · 直连带：配置里有「出站不是分组」的规则/成员，或实时链路里出现了 config 没有的分组时才有；
     · 放在实时循环之后算，降级模式（config 读不到）也能靠实时数据成带。 */
  const groupPartOf2 = (label: string): string => {
    const i = label.indexOf('[');
    return i > 0 ? label.slice(0, i) : label;
  };
  const hasExtraBand =
    stat.nodeRows.some((r) => r.group === '-') ||
    stat.rules.some((r) => !groupByTag.has(r.group)) ||
    [...rowDyn.keys()].some((k) => {
      const g = splitRowKey(k).group;
      return g === '-' || !groupByTag.has(g);
    }) ||
    [...groupDyn.keys()].some((k) => {
      const g = nameOfKey(k);
      return g === '-' || !groupByTag.has(g);
    }) ||
    [...ruleDyn.keys()].some((k) => {
      const g = groupPartOf2(nameOfKey(k));
      return g === '-' || !groupByTag.has(g);
    });
  const bands: FlowBand[] = stat.groups.map((g) => ({
    key: g.tag,
    label: g.tag,
    kind: 'proxy' as FlowKind,
    count: 0,
    members: 0,
    rules: 0,
    group: g.tag,
  }));
  const bandIndex = new Map<string, number>(bands.map((b, i) => [b.key, i]));
  let extraBand = -1;
  if (hasExtraBand) {
    extraBand = bands.length;
    bands.push({ key: '-', label: '直连 / 拦截', kind: 'direct', count: 0, members: 0, rules: 0 });
  }
  /** 分组 tag → band 下标（非分组的出站落到「直连 / 拦截」带） */
  const bandIdxOf = (group: string): number => bandIndex.get(group) ?? extraBand;

  /* ── 静态基线 ── */
  // ③ 一个桶一块小方块（同一分组的多块各自连到 ④ 那张卡）
  const ruleBase: FlowNode[] = stat.tiles.map((t) => ({
    key: t.key,
    name: t.tag,
    badge: t.bucket ? '' : '条件',
    sub: '',
    count: 0,
    kind: t.kind,
    stat: true,
    tip: t.tip,
    order: t.order,
    band: bandIdxOf(t.group),
  }));

  const groupBase: FlowNode[] = stat.groups.map((g, i) => ({
    key: nodeKey('group', g.tag),
    name: g.tag,
    badge: g.badge,
    sub: `${g.members.length} 成员`,
    count: 0,
    kind: 'proxy',
    stat: true,
    tip: `分组 ${g.tag} · ${g.type} · ${g.members.length} 个成员${g.members.length ? `\n${g.members.slice(0, 10).join('、')}${g.members.length > 10 ? ' …' : ''}` : ''}`,
    order: i,
    band: i,
  }));
  // 「直连 / 拦截」带的分组卡（虚线卡片，只为把 ③ 和 ⑤ 连起来）
  if (extraBand >= 0) {
    groupBase.push({
      key: nodeKey('group', '-'),
      name: '直连 / 拦截',
      badge: '无分组',
      sub: `${stat.nodeRows.filter((r) => r.group === '-').length} 成员`,
      count: 0,
      kind: 'direct',
      stat: true,
      tip: '直连 / 拦截 · 出站不经过 selector/urltest\nDIRECT 走直连、block 直接拦截',
      order: 900,
      band: extraBand,
    });
  }

  /** ⑤ 行基线：一行一个 (分组, 成员)，顺序＝config 里 ④ 分组顺序 + 组内成员顺序 */
  const rowBase: FlowNode[] = stat.nodeRows.map((r) => ({
    key: r.key,
    name: r.node,
    badge: r.badge,
    sub: r.server,
    count: 0,
    kind: r.kind,
    stat: true,
    order: r.order,
    proto: r.type,
    group: r.group,
    rowIcon: r.nested ? '#ico-group' : undefined,
    tip: [
      `节点 ${r.node}`,
      `协议 ${r.type}`,
      `服务器 ${r.server}`,
      `所属分组 ${r.group === '-' ? '无分组' : r.group}`,
    ].join('\n'),
    band: bandIdxOf(r.group),
  }));

  // ①列：按（MAC 优先）聚合；标签优先主机名，其次 MAC，最后 IP
  const pcNodes: FlowNode[] = [...pcAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || cmpName(a[0], b[0]))
    .slice(0, FLOW_MAX.pc)
    .map(([key, a]) => {
      const ips = [...a.ips].sort(cmpName);
      const ipText = ips.length ? ips.join('、') : '本机';
      return {
        key,
        name: a.name || a.mac || ips[0] || '本机',
        badge: '',
        sub: ipText,
        count: a.count,
        kind: 'proxy' as FlowKind,
        stat: false,
        order: 0,
        tip: [
          `主机名 ${a.name || '—'}`,
          `MAC ${a.mac || '—'}`,
          `IP ${ipText}${ips.length > 1 ? `（同 MAC 合并 ${ips.length} 个 IP）` : ''}`,
          `连接数 ${a.count}`,
        ].join('\n'),
      };
    });
  // 没有连接时留一个「本机」占位，避免整列塌成空白
  if (!pcNodes.length) {
    pcNodes.push({
      key: nodeKey('pc', '本机'),
      name: '本机',
      badge: '',
      sub: '',
      count: 0,
      kind: 'proxy',
      stat: true,
      tip: '还没有活跃连接（采样 1.5s 一次）',
      order: 0,
    });
  }

  const targets = [...targetDyn.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || cmpName(a.name, b.name));
  const cloudTip = [
    `互联网 · ${total} 条连接 · ${targets.length} 个目标`,
    ...targets.slice(0, 12).map((t) => `${t.name} ×${t.count}`),
    targets.length > 12 ? `…另有 ${targets.length - 12} 个目标` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const cloudNode: FlowNode = {
    key: cloudKey,
    name: '互联网',
    badge: '',
    // 云块第二行显示目标数（明细在 tooltip 里）
    sub: targets.length ? `${targets.length} 个目标` : '云',
    count: total,
    kind: 'proxy',
    stat: true,
    tip: cloudTip,
    order: 0,
  };

  const routerNode: FlowNode = {
    key: routerKey,
    name: routerName,
    badge: '',
    sub: stat.routerSub || 'sing-box',
    count: total,
    kind: 'proxy',
    stat: true,
    tip: `路由器 ${routerName}${stat.routerSub ? ` · ${stat.routerSub}` : ''}\n经过 ${total} 条连接`,
    order: 0,
  };

  const cols: Record<FlowCol, FlowNode[]> = {
    pc: pcNodes,
    router: [routerNode],
    rule: mergeCol(ruleBase, ruleDyn, FLOW_MAX.rule),
    group: mergeCol(groupBase, groupDyn, FLOW_MAX.group),
    // ⑤ 行严格按 config 顺序排（不按命中数重排），否则「④ 分组顺序 + 组内成员顺序」会被打乱
    node: mergeCol(rowBase, rowDyn, FLOW_MAX.node, false),
    cloud: [cloudNode],
  };
  // 合并后补齐 band（实时新增的条目没有 band）：
  //  · ③ 按 label 里 '[' 前面的分组名；④ 按分组 tag；⑤ 按 `node:<分组>/<成员>` 的分组名
  cols.rule = cols.rule.map((n) => {
    // 实时新增的条目 name 是完整 `组[tag]`：方块上只写 tag（组名在 ④），带归属仍按 '[' 前解析
    const full = n.name;
    const lb = full.indexOf('[');
    const rb = full.lastIndexOf(']');
    const tag = lb >= 0 && rb > lb ? full.slice(lb + 1, rb) : full;
    return {
      ...n,
      name: tag,
      band: n.band ?? bandIdxOf(groupPartOf2(full)),
      tip: n.count > 0 ? `${n.tip}\n命中 ${n.count} 条` : n.tip,
    };
  });
  // ⑤ 行在合并之后统一补齐：所属带 / 中间分组（经由）/ 延时状态 / 实时条数
  cols.node = cols.node.map((n) => {
    const mid = rowDyn.get(n.key)?.mid;
    const tag = splitRowKey(n.key).node;
    const delay = delays?.get(tag);
    const latState = latStateOf(delay);
    return {
      ...n,
      band: n.band ?? bandIdxOf(splitRowKey(n.key).group),
      lat: latState === 'none' ? -1 : (delay as number),
      latState,
      tip:
        `${n.tip}${mid ? `\n经由 ${mid}` : ''}` +
        `\n延时 ${latTextOf(delay, latState)}\n实时 ${n.count} 条`,
    };
  });
  cols.group = cols.group.map((n) => {
    const band = n.band ?? bandIdxOf(n.name);
    // 成员延时聚合：只统计有测速的成员（direct/block/未测速不参与平均）
    const tested = cols.node.filter((m) => (m.band ?? 0) === band && (m.lat ?? 0) > 0);
    const avg = tested.length
      ? Math.round(tested.reduce((sum, m) => sum + (m.lat ?? 0), 0) / tested.length)
      : -1;
    const latState = latStateOf(avg);
    return {
      ...n,
      band,
      lat: latState === 'none' ? -1 : avg,
      latState,
      tip: latState === 'none' ? n.tip : `${n.tip}\n平均延时 ${avg} ms（${tested.length} 个成员参与）`,
    };
  });
  // 带去重统计：成员方格数 / 规则卡片数 / 带内总流量
  bands.forEach((b, k) => {
    const members = cols.node.filter((n) => (n.band ?? 0) === k);
    b.members = members.length;
    b.count = members.reduce((sum, n) => sum + n.count, 0);
    b.rules = cols.rule.filter((n) => (n.band ?? 0) === k).length;
  });

  // 活跃节点（活跃连接路径上的 ①..⑥）：纯结构节点不在集合里 → 恒为 false
  for (const col of FLOW_COLS) {
    cols[col] = cols[col].map((n) => ({ ...n, active: activeNodes?.has(n.key) === true }));
  }

  /* ── 结构边：③→④（规则指向分组/节点）、④→⑤（分组→它的每个成员）；纯静态时再补 ①→②、②→③ ── */
  const visible = new Set<string>();
  for (const col of FLOW_COLS) for (const n of cols[col]) visible.add(n.key);
  const structural: FlowEdge[] = [];
  const addStructural = (from: string, to: string): void => {
    if (from === to || !visible.has(from) || !visible.has(to)) return;
    const key = `${from}\u0000${to}`;
    const hit = edges.get(key);
    if (hit) {
      // 已有（实时边或先加的结构边）：结构边一旦有流量就按动态边画
      return;
    }
    if (structural.some((e) => e.key === key)) return;
    structural.push({ key, from, to, count: 0, kind: 'proxy', stat: true });
  };

  for (const t of stat.tiles) {
    addStructural(t.key, nodeKey('group', groupByTag.has(t.group) ? t.group : '-'));
  }
  // ④→⑤：分组 → 它的每个成员方格（结构主边，一条不少；直连/拦截带同样成组）
  for (const r of stat.nodeRows) {
    addStructural(nodeKey('group', r.group), r.key);
  }
  if (total === 0) {
    for (const p of cols.pc) addStructural(p.key, routerKey);
    for (const r of cols.rule) addStructural(routerKey, r.key);
  }

  // 静态边垫底（后画的盖在上面），动态边按条数降序；活跃标记只落在交通边上
  // 每条边都给出显式 active（结构边恒为 false，活跃标记只落在交通边上）
  const edgeList: FlowEdge[] = [
    ...structural,
    ...[...edges.values()].sort((a, b) => b.count - a.count || cmpName(a.key, b.key)),
  ].map((e) => ({ ...e, active: !e.stat && !!activeEdges?.has(e.key) }));

  return {
    pcMode: pcUsedMac ? 'mac' : 'ip',
    stats: {
      total,
      pcs: pcNodes.filter((n) => n.stat === false).length,
      rules: stat.rules.length,
      ruleCards: stat.tiles.length,
      groups: stat.groups.length,
      nodes: stat.nodes.length,
      nodeRows: stat.nodeRows.length,
      bands: bands.length,
      hitRules: ruleDyn.size,
    },
    bands,
    cols,
    edges: edgeList,
    sample,
    ok: stat.ok,
    targets: targets.slice(0, 12),
  };
}

/* ────────────────────────── 活跃边（最近有字节增长） ────────────────────────── */

/** 相邻列 key → 边 key（与 buildFlow 里 edges 的 key 同口径：`from\u0000to`） */
export function edgeKeyOf(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** 一条连接的累计流量（upload+download；缺字段按 0） */
export function trafficTotal(c: Connection | null | undefined): number {
  const o = c as { upload?: unknown; download?: unknown } | null | undefined;
  const up = Number(o?.upload);
  const down = Number(o?.download);
  const sum = (Number.isFinite(up) ? up : 0) + (Number.isFinite(down) ? down : 0);
  return Number.isFinite(sum) ? sum : 0;
}

/** 活跃度状态：由 flow-anim 每 1.5s 采样推进一次 */
export interface ActivityState {
  /** 连接 id → 上次采样到的 upload+download */
  totals: ReadonlyMap<string, number>;
  /** 边 key → 活跃截止时间（ms 时间戳） */
  until: ReadonlyMap<string, number>;
  /** 节点 key → 活跃截止时间（ms 时间戳）；与边同一套过期口径 */
  nodeUntil: ReadonlyMap<string, number>;
}

export interface ActivityStep {
  totals: Map<string, number>;
  until: Map<string, number>;
  nodeUntil: Map<string, number>;
  /** 本次仍然活跃的边 key 集合 */
  active: Set<string>;
  /** 本次仍然活跃的节点 key 集合（活跃连接路径上的全部节点） */
  activeNodes: Set<string>;
}

/**
 * 推进一步活跃度判定：
 *  · 连接累计字节比上次多（或第一次见到）→ 该连接**当前路径**上所有相邻边标记
 *    `activeUntil = now + idleMs`；路径由调用方用最新 flow.sample 提供（天然无延迟）；
 *  · 断开的连接从 totals 里丢掉；until 里已过期的也丢掉（= 恢复闲置样式）。
 */
export function stepActivity(
  conns: readonly Connection[],
  pathsById: ReadonlyMap<string, readonly string[]>,
  prev: ActivityState | null,
  now: number,
  idleMs: number,
): ActivityStep {
  const totals = new Map<string, number>();
  const until = new Map<string, number>();
  const nodeUntil = new Map<string, number>();
  for (const [k, t] of prev?.until ?? []) if (t > now) until.set(k, t);
  for (const [k, t] of prev?.nodeUntil ?? []) if (t > now) nodeUntil.set(k, t);
  for (const c of conns ?? []) {
    const id = String((c as { id?: unknown } | null | undefined)?.id ?? '');
    if (!id) continue;
    const cur = trafficTotal(c);
    const before = prev?.totals.get(id);
    totals.set(id, cur);
    // 首次见到也算活跃；之后只有字节继续增长才算
    const grew = before === undefined ? true : cur > before;
    if (!grew) continue;
    const path = pathsById.get(id);
    if (!path || path.length < 2) continue;
    const exp = now + idleMs;
    // 相邻边（绿色点线）+ 路径上全部节点（①..⑥ 绿色描边）一起点亮
    for (let i = 0; i < path.length - 1; i++) until.set(edgeKeyOf(path[i], path[i + 1]), exp);
    for (const k of path) nodeUntil.set(k, exp);
  }
  return {
    totals,
    until,
    nodeUntil,
    active: new Set(until.keys()),
    activeNodes: new Set(nodeUntil.keys()),
  };
}

/** 活跃集合：边 + 节点（与 stepActivity 的返回同名，方便直接传） */
export interface ActiveMarks {
  edges: ReadonlySet<string>;
  nodes: ReadonlySet<string>;
}

/** 把活跃边/节点贴到 flow 上（只改 active 标志，其余原样返回） */
export function markActive(flow: FlowLayout, marks: ActiveMarks): FlowLayout {
  const edges = flow.edges.map((e) => {
    const a = !e.stat && marks.edges.has(e.key);
    return a === !!e.active ? e : { ...e, active: a };
  });
  let changed = false;
  const cols = {} as Record<FlowCol, FlowNode[]>;
  for (const col of FLOW_COLS) {
    let any = false;
    const mapped = flow.cols[col].map((n) => {
      const a = marks.nodes.has(n.key);
      if (a === !!n.active) return n;
      any = true;
      return { ...n, active: a };
    });
    cols[col] = any ? mapped : flow.cols[col];
    if (any) changed = true;
  }
  return changed ? { ...flow, edges, cols } : { ...flow, edges };
}

/** 兼容旧调用：只贴活跃边 */
export function markActiveEdges(flow: FlowLayout, active: ReadonlySet<string>): FlowLayout {
  return markActive(flow, { edges: active, nodes: new Set<string>() });
}

/* ────────────────────────── 渲染几何（纯数学，无 DOM） ────────────────────────── */

export interface FlowSize {
  w: number;
  h: number;
}

/** 节点锚点：左沿 / 右沿 / 垂直中心（连线与粒子都挂在这上面） */
export interface FlowAnchor {
  x0: number;
  x1: number;
  cy: number;
}

/** 一条横带（band）的几何：整幅宽的一条水平带 + 交替底色 */
export interface FlowBandGeom {
  key: string;
  label: string;
  kind: FlowKind;
  /** 奇数带用浅底（交替） */
  alt: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 带内成员方格数 */
  members: number;
}

/** 列头「＋」按钮几何（③④⑤ 才有；点它新建对应条目） */
export interface FlowAddGeom {
  /** 按钮左上角（画布坐标） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 加号图标的 path（两条线，省得模板里拼） */
  d: string;
  /** 悬停提示（SVG <title>） */
  tip: string;
}

/** 列头几何（含右侧圆角计数 pill） */
export interface FlowColGeom {
  key: FlowCol;
  mark: string;
  title: string;
  sub: string;
  icon: string;
  total: number;
  rows: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 圆角计数 pill */
  pillX: number;
  pillY: number;
  pillW: number;
  pillH: number;
  pillText: string;
  /** 标题字号（窄列缩小一号） */
  titlePx: number;
  /** 是否画右侧计数 pill：列太窄、＋ 与 pill 挤不下时让 pill 让位（总数在顶部统计条仍有） */
  showPill: boolean;
  /** 标题后面的「＋」新建按钮（①②⑥ 为 null） */
  add: FlowAddGeom | null;
}

/** 节点块几何 */
export interface FlowNodeGeom {
  key: string;
  col: FlowCol;
  label: string;
  badge: string;
  count: number;
  kind: FlowKind;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** card = ③④ 文字卡片；tile = ①②⑤ 方格；cloud = ⑥ 大云 */
  mode: 'card' | 'tile' | 'cloud';
  iconSize: number;
  iconX: number;
  iconY: number;
  countX: number;
  countY: number;
  countAnchor: 'start' | 'middle' | 'end';
  tint: string;
  /** 主标题基线 / 次行基线（0 = 不画） */
  labelY: number;
  badgeY: number;
  labelX: number;
  labelAnchor: 'start' | 'middle' | 'end';
  tip: string;
  /** 所属横带下标（③④⑤ 有；①②⑥ 无） */
  band?: number;
  /** 延时色档：⑤ 成员方格与 ④ 分组卡右上角的小圆点用它上色；undefined / none = 不画点 */
  latState?: LatState;
  /** true = 最近有活跃连接经过（绿色描边 + 浅绿底；闲置时 false） */
  active?: boolean;
}

/** 列间连线几何 */
export interface FlowEdgeGeom {
  key: string;
  from: string;
  to: string;
  d: string;
  /** 该方向连接数决定浓度/粗细；0 = 结构边 */
  count: number;
  kind: FlowKind;
  opacity: number;
  width: number;
  stat: boolean;
  /** true = 最近有字节增长（渲染成绿色点线） */
  active: boolean;
}

export interface FlowGeom {
  /** 画布宽（= 容器宽，1:1） */
  w: number;
  /** 画布内容高度：多于容器时由 .flowcanvas 纵向滚动 */
  h: number;
  cols: FlowColGeom[];
  bands: FlowBandGeom[];
  nodes: FlowNodeGeom[];
  edges: FlowEdgeGeom[];
  /** 按节点 key 查锚点（粒子与连线共用） */
  anchors: Map<string, FlowAnchor>;
  /** 被截断丢弃的 key 按列中心兜底定位（粒子不会凭空消失） */
  fallback: (key: string) => FlowAnchor;
}

/** 六列列头文案（①②③④⑤⑥ 与 FLOW_COLS 一一对应） */
export const FLOW_HEADERS: { mark: string; title: string; sub: string; icon: string }[] = [
  { mark: '①', title: '电脑', sub: '按源 IP', icon: '#ico-pc' },
  { mark: '②', title: '路由器', sub: 'sing-box', icon: '#ico-router' },
  { mark: '③', title: '规则集', sub: '一个桶一格 · 悬停看名字', icon: '#ico-rule' },
  { mark: '④', title: '分组', sub: 'Selector / URLTest', icon: '#ico-group' },
  { mark: '⑤', title: '节点', sub: '组成员方格', icon: '#ico-node' },
  { mark: '⑥', title: '互联网', sub: '悬停看目标', icon: '#ico-cloud' },
];

/** 每列节点块的图标（<defs> 里的 symbol） */
export const FLOW_ICONS: Record<FlowCol, string> = {
  pc: '#ico-pc',
  router: '#ico-router',
  rule: '#ico-rule',
  group: '#ico-group',
  node: '#ico-node',
  cloud: '#ico-cloud',
};

/** 布局常量（v4 分带模型：分组=横带，成员=方格网格） */
export const FLOW_GEO = {
  padX: 12,
  headerH: 44,
  topGap: 4,
  bandTopGap: 6,
  bandPadY: 3,
  bandGap: 5,
  minBandH: 34,
  bottomGap: 14,
  colGapMin: 10,
  colGapMax: 18,
  /** ⑤→⑥ 的间隙（汇聚线要看得见） */
  cloudGap: 32,
  /** ⑤ 成员方格 */
  tile: 21,
  tileGap: 5,
  tilePadX: 8,
  /** ③ 小方块（书图标）/ ④ 分组卡片 */
  ruleH: 22,
  /** ③ 小方块的边长（纯图标，名字只在悬停提示里） */
  ruleSquare: 22,
  /** ③ 方格之间的间距 */
  ruleTileGap: 5,
  ruleGap: 3,
  groupH: 32,
  /** ① 电脑方块（方块内放次数，IP 标签在下方） */
  pcTile: 34,
  pcLabelGap: 3,
  pcGap: 14,
  /** ② 路由器方块 */
  routerTile: 56,
  /** ⑥ 云卡片 */
  cloudW: 124,
  cloudH: 108,
  /** 文本容量估算：半角 5.3px、徽章 5.0px */
  namePx: 5.3,
  badgePx: 5.0,
} as const;

/** 列宽规则：⑤ 150–190（每行 5–6 个方格），③④ 吃剩余宽度 */
const COL_WIDTH: Record<FlowCol, { min: number; max: number; weight: number }> = {
  // ① 要能放下 17 字符的 MAC 标签 → 最小宽度略加
  pc: { min: 112, max: 138, weight: 0.55 },
  router: { min: 100, max: 132, weight: 0.55 },
  // ③ 现在是纯书图标方格（不写名字），列可以很窄；省下的宽度给 ⑤
  rule: { min: 56, max: 96, weight: 0.32 },
  group: { min: 106, max: 143, weight: 0.55 },
  // 省下来的宽度给 ⑤：每行能放更多方格
  node: { min: 168, max: 420, weight: 1.6 },
  cloud: { min: 112, max: 150, weight: 0.6 },
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** ③④⑤ 列头「＋」按钮的悬停提示（①②⑥ 没有新建语义 → 不画按钮） */
const ADD_TIPS: Partial<Record<FlowCol, string>> = {
  rule: '新建桶：可多选/批量建，引用到分组（分组也可新建）',
  group: '新建分组：selector / urltest，可勾成员',
  node: '新建节点：表单或分享链接，可加入分组',
};

/** 标题文本宽度估算：CJK ≈ 1em、半角 ≈ 0.56em（列标题是固定短词，够用） */
function titleWidth(s: string, px: number): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.56;
  return n * px;
}

/**
 * 列头标题后面的「＋」按钮几何：紧贴标题末尾（固定 6px 间距，不压文字）。
 * 列太窄、和右侧计数 pill 撞上时由调用方把 pill 藏掉（见下面 showPill 的判定）。
 */
function addButton(col: FlowCol, colX: number, mark: string, title: string, titlePx: number): FlowAddGeom | null {
  const tip = ADD_TIPS[col];
  if (!tip) return null;
  const w = 13;
  const h = 13;
  const y = round1(FLOW_GEO.topGap + 6);
  const x = round1(colX + 25 + titleWidth(`${mark} ${title}`, titlePx) + 6);
  const cx = round1(x + w / 2);
  const cy = round1(y + h / 2);
  return {
    x,
    y,
    w,
    h,
    d: `M${cx} ${round1(y + 3)}V${round1(y + h - 3)}M${round1(x + 3)} ${cy}H${round1(x + w - 3)}`,
    tip,
  };
}

/** 延时（ms）→ 色档；<=0 / 非数字 = 未测速（不画点） */
export function latStateOf(delay: number | null | undefined): LatState {
  // 与 util.latClass 同口径：缺测速=灰(none)；测过但 <=0=红(失败)；<400 绿；<800 黄；其余红
  if (delay === null || delay === undefined || !Number.isFinite(delay)) return 'none';
  if (delay <= 0) return 'r';
  if (delay < LAT_LOW) return 'g';
  if (delay < LAT_MID) return 'y';
  return 'r';
}

/** 色档 → 中文（tooltip 用） */
function latTextOf(delay: number | null | undefined, st: LatState): string {
  if (st === 'none' || delay === null || delay === undefined) return '未测速';
  if (delay <= 0) return '超时/失败';
  return `${delay} ms`;
}

/**
 * 按权重 + 上下限分配六列宽度：总宽先扣掉左右留白与列间距，再按权重分，
 * 越界就夹到 min/max，把差额重新分给还自由的列（多轮收敛）。
 */
function distributeWidths(total: number): Record<FlowCol, number> {
  const out = {} as Record<FlowCol, number>;
  let free: FlowCol[] = [...FLOW_COLS];
  for (let pass = 0; pass < 6 && free.length; pass++) {
    const clampedSum = FLOW_COLS.reduce((n, k) => (free.includes(k) ? n : n + (out[k] ?? 0)), 0);
    const remain = Math.max(0, total - clampedSum);
    const weightSum = free.reduce((n, k) => n + COL_WIDTH[k].weight, 0);
    const unit = remain / weightSum;
    const nextFree: FlowCol[] = [];
    let clamped = false;
    for (const k of free) {
      const want = unit * COL_WIDTH[k].weight;
      const spec = COL_WIDTH[k];
      if (want < spec.min) {
        out[k] = spec.min;
        clamped = true;
      } else if (want > spec.max) {
        out[k] = spec.max;
        clamped = true;
      } else {
        out[k] = round1(want);
        nextFree.push(k);
      }
    }
    free = nextFree;
    if (!clamped) break;
  }
  // 极端窄窗：总需求超过可用宽度时按比例压缩
  const sum = FLOW_COLS.reduce((n, k) => n + (out[k] ?? COL_WIDTH[k].min), 0);
  if (sum > total && sum > 0) {
    const ratio = total / sum;
    for (const k of FLOW_COLS) out[k] = Math.max(72, round1((out[k] ?? COL_WIDTH[k].min) * ratio));
  }
  for (const k of FLOW_COLS) if (!out[k]) out[k] = COL_WIDTH[k].min;
  return out;
}

/** 文本按「半角宽度单位」截断（CJK 算 2 个单位） */
export function fitText(s: string, units: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const w = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (used + w > units) return out ? out + '…' : s.slice(0, 1);
    used += w;
    out += ch;
  }
  return out;
}

/** 两点之间的横向三次贝塞尔（起点右沿 → 终点左沿） */
export function curvePath(a: FlowAnchor, b: FlowAnchor): string {
  const dx = Math.max(10, (b.x0 - a.x1) * 0.5);
  const c1x = a.x1 + dx;
  const c2x = Math.max(a.x1 + 6, b.x0 - dx);
  return `M${round1(a.x1)} ${round1(a.cy)} C${round1(c1x)} ${round1(a.cy)},${round1(c2x)} ${round1(b.cy)},${round1(b.x0)} ${round1(b.cy)}`;
}

/** 同一条贝塞尔在 t∈[0,1] 处的点（粒子沿真实连线走） */
export function bezierAt(a: FlowAnchor, b: FlowAnchor, t: number): { x: number; y: number } {
  const dx = Math.max(10, (b.x0 - a.x1) * 0.5);
  const x0 = a.x1;
  const x1 = a.x1 + dx;
  const x2 = Math.max(a.x1 + 6, b.x0 - dx);
  const x3 = b.x0;
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3,
    y: w0 * a.cy + w1 * a.cy + w2 * b.cy + w3 * b.cy,
  };
}

/** ③ 规则集方格每行放几个（纯图标方格，列窄也能放两三个） */
export function ruleTilesPerRow(colW: number): number {
  return Math.max(1, Math.floor((colW - 8) / (FLOW_GEO.ruleSquare + FLOW_GEO.ruleTileGap)));
}

/** ⑤ 成员网格每行放几个方格（列宽 150 → 5 个，190 → 6 个） */
export function tilesPerRow(colW: number): number {
  const usable = colW - FLOW_GEO.tilePadX * 2;
  return Math.max(2, Math.floor((usable + FLOW_GEO.tileGap) / (FLOW_GEO.tile + FLOW_GEO.tileGap)));
}

/**
 * 六列几何（v4 分带模型）。
 *
 * · ④ 分组 = 每行一条横带（band），按 config 顺序从上到下；带内竖向居中摆 ④ 分组卡、
 *   ③ 规则卡（同组多条规则在带内堆叠）、⑤ 成员方格网格；
 * · ⑤ 成员是正方形小方格（21px，5–6 个一行），跨组重复的成员在自己带内各占一格；
 * · 无分组的直连/拦截规则与出站进「直连 / 拦截」带（置底）；
 * · ① 电脑 / ② 路由器 / ⑥ 云在整幅画布垂直居中；
 * · 不成方框背景：只在带之间用交替浅底 + 极淡分隔线区分。
 */
export function buildLayout(flow: FlowLayout, size: FlowSize): FlowGeom {
  const G = FLOW_GEO;
  const w = Math.max(360, Math.round(size.w || 900));
  const containerH = Math.max(160, Math.round(size.h || 400));
  const gapBase = Math.min(G.colGapMax, Math.max(G.colGapMin, Math.round(w * 0.008)));
  const avail = w - G.padX * 2;
  const gapBudget = gapBase * (FLOW_COLS.length - 2) + G.cloudGap;
  const widths = distributeWidths(avail - gapBudget);
  // 所有列都夹到 max 之后仍有余量：摊到列间距上（比在右侧留一大块空白好看），
  // 并且把 ⑤→⑥ 的间隙固定得略大一点，让汇聚线舒展
  let usedW = FLOW_COLS.reduce((n, k) => n + widths[k], 0);
  let slack = Math.max(0, avail - usedW - gapBudget);
  // 余量先摊到列间距（最多每处 +14，别散得太开），剩下的给 ⑤（每行能多放几格）
  const gapAdd = Math.min(14, slack / (FLOW_COLS.length - 1));
  const gap = round1(gapBase + gapAdd);
  slack -= gapAdd * (FLOW_COLS.length - 1);
  // 还很宽（超宽屏）：不再拉宽列，改成把整块图形居中——③④ 保持收窄，左右留白
  usedW = FLOW_COLS.reduce((n, k) => n + widths[k], 0);
  const cloudGap = round1(Math.max(G.cloudGap, gap + 8));
  const blockW = usedW + gap * (FLOW_COLS.length - 2) + cloudGap;
  const startX = round1(G.padX + Math.max(0, (avail - blockW) / 2));

  // ── 列 x 坐标 ──
  const colX = {} as Record<FlowCol, number>;
  let cx = startX;
  for (const col of FLOW_COLS) {
    colX[col] = round1(cx);
    cx += widths[col] + (col === 'node' ? cloudGap : gap);
  }

  const tpr = tilesPerRow(widths.node);
  const bandsIn: FlowBand[] =
    flow.bands.length > 0
      ? flow.bands
      : [{ key: '-', label: '全部', kind: 'proxy' as FlowKind, count: 0, members: 0, rules: 0 }];
  const bandNodes = (col: FlowCol, k: number): FlowNode[] =>
    flow.cols[col].filter((n) => (n.band ?? 0) === k);

  // ── 每条带的高度：取「成员网格 / 规则堆叠 / 分组卡」三者最大 ──
  const bands: FlowBandGeom[] = [];
  const bandCY: number[] = [];
  const bandGridY: number[] = [];
  /** ③ 方格网格的起始 y（带内按 ③ 自身网格高度居中） */
  const bandRuleGridY: number[] = [];
  let by = G.topGap + G.headerH + G.bandTopGap;
  bandsIn.forEach((b, k) => {
    const members = bandNodes('node', k);
    const rules = bandNodes('rule', k);
    const groups = bandNodes('group', k);
    const rows = Math.max(1, Math.ceil(members.length / tpr));
    const gridH = members.length ? rows * G.tile + (rows - 1) * G.tileGap : 0;
    const tprRule = ruleTilesPerRow(widths.rule);
    const ruleRows = rules.length ? Math.ceil(rules.length / tprRule) : 0;
    const ruleH = ruleRows ? ruleRows * G.ruleSquare + (ruleRows - 1) * G.ruleTileGap : 0;
    const groupH = groups.length ? groups.length * G.groupH + (groups.length - 1) * 4 : 0;
    const contentH = Math.max(gridH, ruleH, groupH, G.minBandH);
    const h = contentH + G.bandPadY * 2;
    bands.push({
      key: b.key,
      label: b.label,
      kind: b.kind,
      alt: k % 2 === 1,
      x: G.padX,
      y: round1(by),
      w: round1(w - G.padX * 2),
      h: round1(h),
      members: members.length,
    });
    bandCY.push(round1(by + G.bandPadY + contentH / 2));
    bandGridY.push(round1(by + G.bandPadY + (contentH - gridH) / 2));
    bandRuleGridY.push(round1(by + G.bandPadY + (contentH - ruleH) / 2));
    by += h + G.bandGap;
  });
  const bandsBottom = by - G.bandGap;
  const viewH = Math.max(containerH, Math.round(bandsBottom + G.bottomGap));
  /**
   * ①②⑥ 的垂直中心。
   * 画布比容器矮时就是整幅画布的中间；画布比容器高（要滚动）时，取「首屏可视区中点」——
   * 否则进页面第一眼 ①②⑥ 三列全是空的，只剩 ③④⑤ 三条带子，看着像没画完。
   */
  const areaTop = G.topGap + G.headerH + G.bandTopGap;
  const wholeCenter = areaTop + (bandsBottom - areaTop) / 2;
  const viewCenter = G.topGap + Math.max(160, (containerH - G.topGap) / 2);
  const centerY = Math.round(Math.min(wholeCenter, viewCenter));

  const cols: FlowColGeom[] = [];
  const nodes: FlowNodeGeom[] = [];
  const anchors = new Map<string, FlowAnchor>();
  const slotAnchors: FlowAnchor[] = [];
  const pushAnchor = (key: string, x0: number, x1: number, y: number, h: number): void => {
    anchors.set(key, { x0: round1(x0), x1: round1(x1), cy: round1(y + h / 2) });
  };

  // ── 列头（图标 + 列名 + 「＋」新建 + 右侧圆角计数 pill + 副标题小字）──
  FLOW_COLS.forEach((col, i) => {
    const head = FLOW_HEADERS[i];
    const colW = Math.max(72, Math.round(widths[col]));
    const list = flow.cols[col];
    const total = list.reduce((n, it) => n + it.count, 0);
    const pillText = String(total);
    const pillH = 14;
    const pillW = Math.max(20, Math.round(10 + pillText.length * 6.2));
    const titlePx = colW < 112 ? 9.5 : 10.5;
    const add = addButton(col, colX[col], head.mark, head.title, titlePx);
    const pillX = round1(colX[col] + colW - 6 - pillW);
    // ＋ 与 pill 撞车时把 pill 藏掉（列太窄的极端情况；总数在顶部统计条里也有）
    const showPill = !add || add.x + add.w + 3 <= pillX;
    cols.push({
      key: col,
      mark: head.mark,
      title: head.title,
      sub: col === 'pc' ? (flow.pcMode === 'mac' ? '按 MAC · 回落 IP' : '按源 IP') : head.sub,
      icon: head.icon,
      total,
      rows: list.length,
      x: colX[col],
      y: G.topGap,
      w: colW,
      h: Math.max(120, viewH - G.topGap * 2),
      pillX,
      pillY: G.topGap + 6,
      pillW,
      pillH,
      pillText,
      titlePx,
      showPill,
      add,
    });
    slotAnchors.push({ x0: colX[col], x1: round1(colX[col] + colW), cy: centerY });
  });

  // ── ① 电脑：正方形方块（内含次数）+ IP 标签，整幅垂直居中 ──
  {
    const list = flow.cols.pc;
    const tile = G.pcTile;
    const labelH = 12;
    const totalH = list.length
      ? list.length * tile + (list.length - 1) * (labelH + G.pcLabelGap) + labelH
      : 0;
    let y = Math.round(centerY - totalH / 2);
    const x = round1(colX.pc + (widths.pc - tile) / 2);
    const units = Math.max(4, Math.floor((widths.pc - 4) / 4.7));
    for (const it of list) {
      nodes.push({
        key: it.key,
        col: 'pc',
        label: fitText(it.name, units),
        badge: '',
        count: it.count,
        kind: it.kind,
        icon: FLOW_ICONS.pc,
        x,
        y,
        w: tile,
        h: tile,
        mode: 'tile',
        iconSize: 16,
        iconX: round1(x + (tile - 16) / 2),
        iconY: y + 5,
        countX: round1(x + tile / 2),
        countY: y + tile - 5,
        countAnchor: 'middle',
        tint: 'col-pc',
        labelY: y + tile + 10,
        badgeY: 0,
        labelX: round1(colX.pc + widths.pc / 2),
        labelAnchor: 'middle',
        tip: it.tip || it.name,
      });
      pushAnchor(it.key, x, x + tile, y, tile);
      y += tile + G.pcLabelGap + labelH;
    }
  }

  // ── ② 路由器：一个方块，整幅垂直居中 ──
  {
    const it = flow.cols.router[0];
    if (it) {
      const tile = G.routerTile;
      const x = round1(colX.router + (widths.router - tile) / 2);
      const y = Math.round(centerY - tile / 2);
      const units = Math.max(4, Math.floor((widths.router - 4) / 4.7));
      nodes.push({
        key: it.key,
        col: 'router',
        label: fitText(it.sub || '', units),
        badge: '',
        count: it.count,
        kind: it.kind,
        icon: FLOW_ICONS.router,
        x,
        y,
        w: tile,
        h: tile,
        mode: 'tile',
        iconSize: 28,
        iconX: round1(x + (tile - 28) / 2),
        iconY: y + 8,
        countX: round1(x + tile / 2),
        countY: y + tile - 6,
        countAnchor: 'middle',
        tint: 'col-router',
        labelY: y + tile + 11,
        badgeY: 0,
        labelX: round1(colX.router + widths.router / 2),
        labelAnchor: 'middle',
        tip: it.tip || it.name,
      });
      pushAnchor(it.key, x, x + tile, y, tile);
    }
  }

  // ── ⑥ 云：一朵大云，整幅垂直居中 ──
  {
    const it = flow.cols.cloud[0];
    if (it) {
      const cw = Math.min(G.cloudW, Math.round(widths.cloud));
      const ch = G.cloudH;
      const x = round1(colX.cloud + (widths.cloud - cw) / 2);
      const y = Math.round(centerY - ch / 2);
      nodes.push({
        key: it.key,
        col: 'cloud',
        label: '',
        badge: fitText(it.sub || '', Math.max(4, Math.floor((cw - 12) / 4.8))),
        count: it.count,
        kind: it.kind,
        icon: FLOW_ICONS.cloud,
        x,
        y,
        w: cw,
        h: ch,
        mode: 'cloud',
        iconSize: 40,
        iconX: round1(x + (cw - 40) / 2),
        iconY: y + 12,
        countX: round1(x + cw / 2),
        countY: y + 76,
        countAnchor: 'middle',
        tint: 'col-cloud',
        labelY: 0,
        badgeY: y + ch - 11,
        labelX: round1(x + cw / 2),
        labelAnchor: 'middle',
        tip: it.tip || '互联网',
      });
      pushAnchor(it.key, x, x + cw, y, ch);
    }
  }

  // ── ③④⑤：逐带摆（带内竖向居中）──
  bandsIn.forEach((b, k) => {
    const cy = bandCY[k];
    const tprRule = ruleTilesPerRow(widths.rule);
    // ③ 规则集方格：纯书图标，横向一行排满再换行（和 ⑤ 成员方格同款；名字只在悬停提示里）
    const rules = bandNodes('rule', k);
    if (rules.length) {
      const side = G.ruleSquare;
      const step = side + G.ruleTileGap;
      const gridX = round1(colX.rule + 4);
      const gridY = bandRuleGridY[k];
      const colW = widths.rule;
      rules.forEach((it, idx) => {
        const row = Math.floor(idx / tprRule);
        const col = idx % tprRule;
        const x = round1(gridX + col * step);
        const y = round1(gridY + row * step);
        nodes.push({
          key: it.key,
          col: 'rule',
          label: '',
          badge: it.badge ?? '',
          count: it.count,
          kind: it.kind,
          icon: FLOW_ICONS.rule,
          x,
          y,
          w: side,
          h: side,
          mode: 'tile',
          iconSize: 12,
          iconX: round1(x + (side - 12) / 2),
          iconY: round1(y + (side - 12) / 2),
          countX: 0,
          countY: 0,
          countAnchor: 'end',
          tint: it.kind === 'direct' ? 'direct' : it.kind === 'block' ? 'block' : 'col-rule',
          labelY: 0,
          badgeY: 0,
          labelX: 0,
          labelAnchor: 'start',
          tip: it.tip || it.name,
          band: k,
        });
        pushAnchor(it.key, x, x + colW, y, side);
      });
    }
    // ④ 分组卡片：带内垂直居中
    const groups = bandNodes('group', k);
    if (groups.length) {
      const blockH = groups.length * G.groupH + (groups.length - 1) * 4;
      let y = Math.round(cy - blockH / 2);
      const x = colX.group;
      const colW = widths.group;
      const nameUnits = Math.max(8, Math.floor((colW - 50) / G.namePx));
      const badgeUnits = Math.max(6, Math.floor((colW - 30) / G.badgePx));
      for (const it of groups) {
        const line2 = it.badge && it.sub ? `${it.badge} · ${it.sub}` : it.badge || it.sub || '';
        nodes.push({
          key: it.key,
          col: 'group',
          label: fitText(it.name, nameUnits),
          badge: line2 ? fitText(line2, badgeUnits) : '',
          count: it.count,
          kind: it.kind,
          icon: FLOW_ICONS.group,
          x,
          y,
          w: round1(colW),
          h: G.groupH,
          mode: 'card',
          iconSize: 13,
          iconX: round1(x + 7),
          iconY: round1(y + 6),
          countX: round1(x + colW - 8),
          countY: y + 14,
          countAnchor: 'end',
          tint: it.kind === 'direct' ? 'direct' : 'col-group',
          labelY: y + 14,
          badgeY: y + 27,
          labelX: round1(x + 25),
          labelAnchor: 'start',
          tip: it.tip || it.name,
          band: k,
          latState: it.latState,
        });
        pushAnchor(it.key, x, x + colW, y, G.groupH);
        y += G.groupH + 4;
      }
    }
    // ⑤ 成员方格网格：带内垂直居中，行优先排满一行再换行
    const members = bandNodes('node', k);
    if (members.length) {
      const tile = G.tile;
      const gridX = round1(colX.node + G.tilePadX);
      const gridY = bandGridY[k];
      members.forEach((it, idx) => {
        const row = Math.floor(idx / tpr);
        const col = idx % tpr;
        const x = round1(gridX + col * (tile + G.tileGap));
        const y = round1(gridY + row * (tile + G.tileGap));
        nodes.push({
          key: it.key,
          col: 'node',
          label: '',
          badge: '',
          count: it.count,
          kind: it.kind,
          icon: it.rowIcon ?? FLOW_ICONS.node,
          x,
          y,
          w: tile,
          h: tile,
          mode: 'tile',
          iconSize: 13,
          iconX: round1(x + (tile - 13) / 2),
          iconY: round1(y + (tile - 13) / 2),
          countX: 0,
          countY: 0,
          countAnchor: 'end',
          tint: it.rowIcon ? 'col-group' : it.kind !== 'proxy' ? it.kind : protoTint(it.proto ?? ''),
          labelY: 0,
          badgeY: 0,
          labelX: x,
          labelAnchor: 'start',
          tip: it.tip || it.name,
          band: k,
          latState: it.latState,
        });
        pushAnchor(it.key, x, x + tile, y, tile);
      });
    }
  });

  // 活跃标记（几何层统一打一次，六个列都覆盖）
  const activeKeys = new Set<string>();
  for (const col of FLOW_COLS) for (const n of flow.cols[col]) if (n.active) activeKeys.add(n.key);
  for (const g of nodes) g.active = activeKeys.has(g.key);

  // 被截断的节点按列中心兜底（粒子不会凭空消失）
  const fallback = (key: string): FlowAnchor => slotAnchors[FLOW_COLS.indexOf(colOfKey(key))] ?? slotAnchors[0];

  // ── 连线：线宽/透明度按 count 加权 ──
  const edges: FlowEdgeGeom[] = flow.edges.map((e) => {
    const a = anchors.get(e.from) ?? fallback(e.from);
    const b = anchors.get(e.to) ?? fallback(e.to);
    return {
      key: e.key,
      from: e.from,
      to: e.to,
      d: curvePath(a, b),
      count: e.count,
      kind: e.kind,
      // 活跃边（最近有字节增长）用绿色点线，透明度比闲置高一点
      opacity: e.active ? 0.9 : e.stat ? 0.12 : round1(Math.min(0.6, 0.14 + Math.log2(1 + e.count) * 0.14)),
      width: e.stat ? 0.8 : round1(Math.min(2.8, 0.9 + Math.log2(e.count) * 0.6)),
      stat: e.stat,
      active: e.active === true,
    };
  });

  return { w, h: viewH, cols, bands, nodes, edges, anchors, fallback };
}

/**
 * 一条列 key 路径在 t∈[0,1] 处的**前进方向**（角度，度；0 = 朝 +x，90 = 朝 +y）。
 * 用中心差分取 t±ε 两点算 atan2，粒子（小鱼）按它转向；退化时返回 0。
 */
export function tangentOnPath(
  keys: readonly string[],
  t: number,
  geom: FlowGeom,
  eps = 0.004,
): number {
  const a = pointOnPath(keys, Math.max(0, t - eps), geom);
  const b = pointOnPath(keys, Math.min(1, t + eps), geom);
  if (!a || !b) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** 一条列 key 路径在 t∈[0,1] 处的坐标（各段均分时间，段内走真实贝塞尔） */
export function pointOnPath(keys: readonly string[], t: number, geom: FlowGeom): { x: number; y: number } | null {
  const segs = keys.length - 1;
  if (segs < 1) return null;
  const u = Math.min(1, Math.max(0, t)) * segs;
  const idx = Math.min(segs - 1, Math.floor(u));
  const a = geom.anchors.get(keys[idx]) ?? geom.fallback(keys[idx]);
  const b = geom.anchors.get(keys[idx + 1]) ?? geom.fallback(keys[idx + 1]);
  if (!a || !b) return null;
  return bezierAt(a, b, u - idx);
}