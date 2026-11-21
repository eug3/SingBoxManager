/**
 * flow-model.ts — 「流向」六列视图的纯函数层（无 Angular / DOM 依赖）。
 *
 * 静态骨架来自 sing-box config.json（`buildStatic`），实时流量来自 clash_api `/connections`
 * （`buildFlow`），六列口径见 docs/plan-flow-v2.md：
 *
 *   ① pc     每台源主机（metadata.sourceIP，缺省「本机」）+ 连接数
 *   ② router sing-box 所在设备（单节点，名字由调用方通过 stat.routerName 传入）
 *   ③ rule   规则集条目，形如 `分组名[规则 tag]`（例 `OpenAi[rs-openai]`）
 *   ④ group  selector / urltest 分组（badge：手动 / 延迟排序 / 负载均衡）
 *   ⑤ node   代理出站节点（badge：协议简写 ss / hy2 / vless …）
 *   ⑥ cloud  实时目标 host / sniffHost / destinationIP（本列只来自实时连接）
 *
 * 关键口径：
 *  · ③ 先用 `conn.rule` + `conn.rulePayload` 反查静态规则（`rule='rule_set'` 时 rulePayload 就是
 *    rule_set 的 tag）；命不中时退化成 `chains[0][rule]`（组名 + 规则类型），再不行用 `?[payload]`。
 *  · DIRECT / block 短路：③ 直接连 ⑥，不再经过 ④⑤；节点按 direct(灰) / block(红) 着色。
 *  · 零流量也输出 ③④⑤ 的静态节点（count=0），并用 config 结构补 ③→④、④→⑤ 的静态边，
 *    这样「还没有连接」时看到的是配置拓扑而不是空画布。
 *  · 静态条目与实时条目用同一套 key（`列:名称`）合流：config 里有、这次没命中的条目 count=0
 *    仍然展示；实时出现、config 里没有的条目（例如配置读不到）追加在后面。
 */
import { GROUP_TYPES, SPECIAL_TYPES, parseConfig } from './config-ops';
import type { AnyObj } from './config-ops';
import type { Connection } from './models';

/** 六列（数组顺序即渲染顺序，粒子也按这个方向走） */
export const FLOW_COLS = ['pc', 'router', 'rule', 'group', 'node', 'cloud'] as const;
export type FlowCol = (typeof FLOW_COLS)[number];

/** 节点视觉类别：直连灰 / 代理蓝 / 拦截红 */
export type FlowKind = 'direct' | 'proxy' | 'block';

/**
 * 每列最多展示的节点数（超出的节点仍会出现在 sample 路径里，由渲染层按列中心兜底定位）。
 * 规则/分组/节点三列是「结构」主体，给得宽一些；电脑与目标只是分布概览。
 */
export const FLOW_MAX: Record<FlowCol, number> = { pc: 6, router: 1, rule: 12, group: 8, node: 10, cloud: 10 };

/* ────────────────────────────── 类型 ────────────────────────────── */

/** ③ 规则集条目（一条 route 规则聚合后的展示单元） */
export interface StaticRule {
  /** `rule:` + label，跨列唯一 */
  key: string;
  /** outbound tag（规则指向的分组 / 节点 / DIRECT / block） */
  group: string;
  /** 规则 tag：rule_set 的 tag；无 rule_set 时是规则类型（domain_suffix…）或 '直连'/'拦截'/'final' */
  ruleTag: string;
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

/** ⑤ 代理出站节点（含 endpoints 里的 masque / wireguard 等） */
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
  groups: StaticGroup[];
  nodes: StaticNode[];
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
  /** `列:名称` */
  key: string;
  /** 主标题原文（渲染层按列宽截断） */
  name: string;
  /** 次行徽章（规则：直连/拦截；分组：手动/延迟排序；节点：协议简写 ss/hy2…） */
  badge: string;
  /** 次行副标题：没有徽章时用它（②列显示引擎版本，分组显示成员数，节点显示 server） */
  sub: string;
  /** 经过该节点的连接数（静态节点可能为 0） */
  count: number;
  kind: FlowKind;
  /** true = 来自 config 的静态条目 */
  stat: boolean;
  /** hover tooltip 的完整描述 */
  tip: string;
  /** 列内排序权重：静态条目取 config 顺序，实时新条目排在后面 */
  order: number;
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
  /** config 里的分组个数 */
  groups: number;
  /** config 里的节点个数 */
  nodes: number;
  /** 本次采样实际命中的规则条目数 */
  hitRules: number;
}

export interface FlowLayout {
  stats: FlowStats;
  cols: Record<FlowCol, FlowNode[]>;
  edges: FlowEdge[];
  sample: FlowSample[];
  /** 静态结构是否可用（false = 仅实时模式） */
  ok: boolean;
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
};

export function protoBadge(type: string): string {
  const t = (type ?? '').trim().toLowerCase();
  return PROTO_BADGE[t] ?? (t || '?');
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
  const kind = flowKind(group);
  if (kind === 'direct') return '直连';
  if (kind === 'block') return '拦截';
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

/* ─────────────────────── ② 节点 server:port ─────────────────────── */

function serverOf(o: AnyObj): string {
  const host = str(o['server']);
  if (!host) return '—';
  const port = str(o['server_port']);
  return port ? `${host}:${port}` : host;
}

/* ────────────────────────────── buildStatic ────────────────────────────── */

/** 空静态结构（配置还没拉到时用；ok=false 会让界面提示「仅实时」） */
export function emptyStatic(routerName = 'sing-box', routerSub = ''): FlowStat {
  return { ok: false, rules: [], groups: [], nodes: [], routerName, routerSub };
}

/**
 * 解析整份 sing-box config.json → ③④⑤ 三列的结构。
 * 只读，不改任何东西；JSON 坏掉/不是对象时返回 ok=false + 中文 error，不抛。
 */
export function buildStatic(configText: string): FlowStatic {
  const empty = (err: string): FlowStatic => ({ ok: false, err, rules: [], groups: [], nodes: [] });
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

  // ── ⑤ 节点：非分组、非 direct/block/dns 的出站（含 endpoints） ──
  const nodes: StaticNode[] = [];
  const nodeTags = new Set<string>();
  for (const o of [...outbounds, ...endpoints]) {
    const type = str(o['type']);
    if (GROUP_TYPES.has(type) || SPECIAL_TYPES.has(type)) continue;
    const tag = str(o['tag']) || '?';
    if (nodeTags.has(tag)) continue;
    nodeTags.add(tag);
    nodes.push({ tag, type, kind: 'proxy', badge: protoBadge(type), server: serverOf(o) });
  }

  // ── ③ 规则：route.rules[] + route.final ──
  const rules: StaticRule[] = [];
  const byLabel = new Map<string, StaticRule>();
  const addRule = (group: string, ruleTag: string, match: string): void => {
    if (!group) return;
    const label = `${group}[${ruleTag}]`;
    const hit = byLabel.get(label);
    if (hit) {
      hit.refs++;
      if (!hit.match && match) hit.match = match;
      return;
    }
    const rule: StaticRule = {
      key: nodeKey('rule', label),
      group,
      ruleTag,
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
    addRule(group, ruleTagOf(r, group), matchSummary(r));
  });

  // final：没有 rule_set，label 形如 `节点选择[final]`
  const finalTag = str(route?.['final']);
  if (finalTag) addRule(finalTag, 'final', '未命中任何规则时的兜底出站');

  return { ok: true, rules, groups, nodes };
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

/** 连接终点标签（⑥列节点名）：host / sniffHost / destinationIP，最多 40 字 */
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

/** 一条连接命中的规则标签：静态反查优先，命不中按 `组名[规则类型]` 兜底 */
function ruleLabelOf(
  c: Connection,
  chains: string[],
  stat: FlowStat,
  byRuleTag: Map<string, StaticRule>,
): { label: string; kind: FlowKind; hit?: StaticRule } {
  const parsed = parseRuleText(c.rule ?? '');
  const payload = (c.rulePayload ?? '').trim();
  const outTag = chains.length ? chains[chains.length - 1] : '';
  const chainGroup = chains.length ? chains[0] : '';
  const kind = flowKind(outTag || chainGroup);

  // rule_set 规则：桶名可能来自 rulePayload，也可能埋在 rule 文本里（'rule_set=xxx => route(yyy)'）
  const bucket = payload && !payload.includes('=') ? payload : parsed.bucket;
  const hit = bucket ? byRuleTag.get(bucket) : undefined;
  if (hit) return { label: hit.label, kind: hit.kind === 'proxy' ? kind : hit.kind, hit };

  // 兜底：分组名优先用 route(…) 里的真实出站，其次链路首段
  const group = parsed.group || chainGroup || outTag || 'DIRECT';
  const tag = bucket || parsed.matcher || (stat.ok ? 'final' : '未知');
  return { label: `${group}[${tag}]`, kind };
}

/* ────────────────────────────── 合流 ────────────────────────────── */

/** 实时计数条目（徽章/副标题只有 config 基线条目才有；这里补 kind 与 tooltip） */
interface DynInfo {
  count: number;
  kind: FlowKind;
  badge?: string;
  tip?: string;
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
 *  · 排序：命中数降序 → 静态顺序升序 → 名称。
 */
function mergeCol(base: FlowNode[], dyn: Map<string, DynInfo>, max: number): FlowNode[] {
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
  list.sort((a, b) => b.count - a.count || a.order - b.order || cmpName(a.name, b.name));
  return list.slice(0, max);
}

/* ────────────────────────────── buildFlow ────────────────────────────── */

/**
 * 连接列表 + 静态结构 → 六列布局。
 *
 * @param conns clash_api /connections 的 connections 数组
 * @param stat  buildStatic 的结果 + ②列名字；配置读不到时传 emptyStatic()
 */
export function buildFlow(conns: Connection[], stat: FlowStat): FlowLayout {
  const routerName = stat.routerName || 'sing-box';
  const routerKey = nodeKey('router', routerName);

  // 静态索引（反查 / 补徽章用）
  const byRuleTag = new Map<string, StaticRule>();
  for (const r of stat.rules) if (!byRuleTag.has(r.ruleTag)) byRuleTag.set(r.ruleTag, r);
  const groupByTag = new Map(stat.groups.map((g) => [g.tag, g]));
  const nodeByTag = new Map(stat.nodes.map((n) => [n.tag, n]));

  const pcDyn = new Map<string, DynInfo>();
  const ruleDyn = new Map<string, DynInfo>();
  const groupDyn = new Map<string, DynInfo>();
  const nodeDyn = new Map<string, DynInfo>();
  const cloudDyn = new Map<string, DynInfo>();
  const edges = new Map<string, FlowEdge>();
  const sample: FlowSample[] = [];
  let total = 0;

  for (const c of conns ?? []) {
    const chains = chainsOf(c);
    const outTag = chains.length ? chains[chains.length - 1] : '';
    const src = sourceLabel(c);
    const dest = destLabel(c);
    const { label, kind: ruleKind, hit } = ruleLabelOf(c, chains, stat, byRuleTag);

    const entries: { col: FlowCol; key: string }[] = [
      { col: 'pc', key: nodeKey('pc', src) },
      { col: 'router', key: routerKey },
      { col: 'rule', key: nodeKey('rule', label) },
    ];

    const shortCircuit = chains.length === 0 || flowKind(outTag) !== 'proxy';
    let pathKindFlag: FlowKind = ruleKind;
    if (!shortCircuit) {
      pathKindFlag = flowKind(outTag);
      if (chains.length >= 2) {
        // chains[0]=分组、chains[last]=节点（中间嵌套组不单独成列，保持六列语义）
        entries.push({ col: 'group', key: nodeKey('group', chains[0]) });
      }
      entries.push({ col: 'node', key: nodeKey('node', outTag) });
    }
    entries.push({ col: 'cloud', key: nodeKey('cloud', dest) });

    // 计数
    total++;
    bumpDyn(pcDyn, entries[0].key, 'proxy');
    bumpDyn(ruleDyn, entries[2].key, ruleKind, kindBadge(ruleKind));
    if (!shortCircuit) {
      const groupTag = chains.length >= 2 ? chains[0] : '';
      if (groupTag) {
        const g = groupByTag.get(groupTag);
        bumpDyn(groupDyn, nodeKey('group', groupTag), 'proxy', g?.badge ?? guessGroupBadge(groupTag));
      }
      const n = nodeByTag.get(outTag);
      bumpDyn(nodeDyn, nodeKey('node', outTag), 'proxy', n?.badge ?? '');
    }
    bumpDyn(cloudDyn, entries[entries.length - 1].key, 'proxy');

    // 边（相邻两列）+ 抽样路径
    for (let i = 0; i < entries.length - 1; i++) {
      const from = entries[i].key;
      const to = entries[i + 1].key;
      const key = `${from}\u0000${to}`;
      const e = edges.get(key);
      if (e) e.count++;
      else edges.set(key, { key, from, to, count: 1, kind: pathKindFlag, stat: false });
    }
    sample.push({ id: c.id ?? `${src}>${dest}#${sample.length}`, path: entries.map((e) => e.key), kind: pathKindFlag });

    // 命中规则的 tooltip 用静态匹配条件补全
    if (hit) {
      const info = ruleDyn.get(entries[2].key);
      if (info && !info.tip) info.tip = `规则 ${label}${hit.match ? '\n' + hit.match : ''}`;
    }
  }

  /* ── 静态基线（三列结构，0 流量也展示） ── */
  const ruleBase: FlowNode[] = stat.rules.map((r) => ({
    key: r.key,
    name: r.label,
    badge: kindBadge(r.kind),
    sub: '',
    count: 0,
    kind: r.kind,
    stat: true,
    tip: `规则 ${r.label}${r.match ? '\n' + r.match : ''}${r.refs > 1 ? `\n（config 里 ${r.refs} 条规则指向它）` : ''}`,
    order: r.order,
  }));

  const groupBase: FlowNode[] = stat.groups.map((g, i) => ({
    key: nodeKey('group', g.tag),
    name: g.tag,
    badge: g.badge,
    sub: `${g.members.length} 成员`,
    count: 0,
    kind: 'proxy',
    stat: true,
    tip: `分组 ${g.tag} · ${g.type} · ${g.members.length} 个成员${g.members.length ? `\n${g.members.slice(0, 8).join('、')}${g.members.length > 8 ? ' …' : ''}` : ''}`,
    order: i,
  }));

  const nodeBase: FlowNode[] = stat.nodes.map((n, i) => ({
    key: nodeKey('node', n.tag),
    name: n.tag,
    badge: n.badge,
    sub: n.server,
    count: 0,
    kind: 'proxy',
    stat: true,
    tip: `节点 ${n.tag} · ${n.type} · ${n.server}`,
    order: i,
  }));

  // ①列：没有连接时留一个「本机」占位，避免整列塌成空白
  const pcBase: FlowNode[] =
    pcDyn.size > 0
      ? []
      : [
          {
            key: nodeKey('pc', '本机'),
            name: '本机',
            badge: '',
            sub: '',
            count: 0,
            kind: 'proxy',
            stat: true,
            tip: '还没有活跃连接（采样 1.5s 一次）',
            order: 0,
          },
        ];

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
    pc: mergeCol(pcBase, pcDyn, FLOW_MAX.pc),
    router: [routerNode],
    rule: mergeCol(ruleBase, ruleDyn, FLOW_MAX.rule),
    group: mergeCol(groupBase, groupDyn, FLOW_MAX.group),
    node: mergeCol(nodeBase, nodeDyn, FLOW_MAX.node),
    cloud: mergeCol([], cloudDyn, FLOW_MAX.cloud),
  };

  /* ── 结构边：③→④（规则指向分组/节点）、④→⑤（分组成员）；纯静态时再补 ①→②、②→③ ── */
  const visible = new Set<string>();
  for (const col of FLOW_COLS) for (const n of cols[col]) visible.add(n.key);
  const structural: FlowEdge[] = [];
  const addStructural = (from: string, to: string): void => {
    if (from === to || !visible.has(from) || !visible.has(to)) return;
    const key = `${from}\u0000${to}`;
    if (edges.has(key) || structural.some((e) => e.key === key)) return;
    structural.push({ key, from, to, count: 0, kind: 'proxy', stat: true });
  };

  for (const r of stat.rules) {
    const from = r.key;
    if (groupByTag.has(r.group)) addStructural(from, nodeKey('group', r.group));
    else if (nodeByTag.has(r.group)) addStructural(from, nodeKey('node', r.group));
  }
  for (const g of stat.groups) {
    const from = nodeKey('group', g.tag);
    for (const mem of g.members) {
      // 成员是节点才连（嵌套组不画同列连线，避免同列横穿）
      if (nodeByTag.has(mem)) addStructural(from, nodeKey('node', mem));
    }
  }
  if (total === 0) {
    for (const p of cols.pc) addStructural(p.key, routerKey);
    for (const r of cols.rule) addStructural(routerKey, r.key);
  }

  // 静态边垫底（后画的盖在上面），动态边按条数降序
  const edgeList: FlowEdge[] = [
    ...structural,
    ...[...edges.values()].sort((a, b) => b.count - a.count || cmpName(a.key, b.key)),
  ];

  return {
    stats: {
      total,
      pcs: pcDyn.size,
      rules: stat.rules.length,
      groups: stat.groups.length,
      nodes: stat.nodes.length,
      hitRules: ruleDyn.size,
    },
    cols,
    edges: edgeList,
    sample,
    ok: stat.ok,
  };
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

/** 列头几何 */
export interface FlowColGeom {
  key: FlowCol;
  mark: string;
  title: string;
  sub: string;
  icon: string;
  /** 该列累计连接数（列头右上角） */
  total: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 节点块几何（文本已按列宽截断，label/badge 直接进 <text>） */
export interface FlowNodeGeom {
  key: string;
  col: FlowCol;
  label: string;
  /** 次行文本：有徽章用徽章，没有徽章用副标题（如 `sing-box 1.11.0`） */
  badge: string;
  count: number;
  kind: FlowKind;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 主标题基线 */
  labelY: number;
  /** 徽章基线；0 = 该块没有徽章，标题垂直居中 */
  badgeY: number;
  tip: string;
}

/** 列间连线几何 */
export interface FlowEdgeGeom {
  key: string;
  from: string;
  to: string;
  d: string;
  /** 该方向连接数决定浓度/粗细；0 = 结构边 */
  count: number;
  /** 出口类型（代理蓝 / 直连灰 / 拦截红，与粒子同色系） */
  kind: FlowKind;
  opacity: number;
  width: number;
  stat: boolean;
}

export interface FlowGeom {
  cols: FlowColGeom[];
  nodes: FlowNodeGeom[];
  edges: FlowEdgeGeom[];
  /** 按节点 key 查锚点（粒子与连线共用） */
  anchors: Map<string, FlowAnchor>;
  /** 列被截断丢弃的 key 按列中心兜底定位（粒子不会凭空消失） */
  fallback: (key: string) => FlowAnchor;
}

/** 六列列头文案（①②③④⑤⑥ 与 FLOW_COLS 一一对应） */
export const FLOW_HEADERS: { mark: string; title: string; sub: string; icon: string }[] = [
  { mark: '①', title: '电脑', sub: '按源 IP', icon: '#ico-pc' },
  { mark: '②', title: '路由器', sub: 'sing-box', icon: '#ico-router' },
  { mark: '③', title: '规则集', sub: '规则集 → 分组', icon: '#ico-rule' },
  { mark: '④', title: '分组', sub: 'Selector / URLTest', icon: '#ico-group' },
  { mark: '⑤', title: '节点', sub: '出口节点', icon: '#ico-node' },
  { mark: '⑥', title: '互联网', sub: '目标', icon: '#ico-cloud' },
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

/** 布局常量（渲染层与预览脚本共用同一套数） */
export const FLOW_GEO = {
  padX: 12,
  headerH: 44,
  minSlotW: 96,
  minColW: 72,
  minColH: 150,
  maxStep: 84,
  /** 文本容量估算：半角 5.3px、徽章 5.0px */
  namePx: 5.3,
  badgePx: 5.0,
} as const;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 文本按「半角宽度单位」截断（CJK 算 2 个单位），保证节点名不压到右侧次数 */
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

/** 两点之间的横向三次贝塞尔（起点右沿 → 终点左沿），控制点水平外推 */
export function curvePath(a: FlowAnchor, b: FlowAnchor): string {
  const dx = Math.max(10, (b.x0 - a.x1) * 0.5);
  const c1x = a.x1 + dx;
  const c2x = Math.max(a.x1 + 6, b.x0 - dx);
  return `M${round1(a.x1)} ${round1(a.cy)} C${round1(c1x)} ${round1(a.cy)},${round1(c2x)} ${round1(b.cy)},${round1(b.x0)} ${round1(b.cy)}`;
}

/** 同一条贝塞尔在 t∈[0,1] 处的点（粒子沿真实连线走，不另算路径） */
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

/**
 * 六列几何：列背景/列头、节点块、列间连线，以及按 key 查锚点的索引。
 *
 * 布局口径（v2）：
 *  · 列宽 = 容器宽均分六列，列高撑满；纵向类桑基铺开（节点少就拉开、多就压紧，整列居中）；
 *  · 节点块：左侧图标 + 主标题 + 次行徽章 + 右侧次数；有徽章时两行，无徽章时标题垂直居中；
 *  · 结构边（config 拓扑）走浅色虚线；动态边随连接数加粗加深。
 */
export function buildLayout(flow: FlowLayout, size: FlowSize): FlowGeom {
  const { w, h } = size;
  const G = FLOW_GEO;
  const slotW = Math.max(G.minSlotW, (w - G.padX * 2) / FLOW_COLS.length);
  const gap = Math.min(18, Math.max(10, slotW * 0.1));
  const colW = Math.max(G.minColW, slotW - gap);
  const top = 4 + G.headerH;
  const bottom = Math.max(top + 64, h - 10);
  const avail = bottom - top;

  const cols: FlowColGeom[] = [];
  const nodes: FlowNodeGeom[] = [];
  const anchors = new Map<string, FlowAnchor>();
  const slotAnchors: FlowAnchor[] = [];
  // 文本容量：扣掉左侧图标（24）与右侧次数（24）后按像素/半角估算
  const nameUnits = Math.max(5, Math.floor((colW - 48) / G.namePx));
  const badgeUnits = Math.max(4, Math.floor((colW - 30) / G.badgePx));

  FLOW_COLS.forEach((col, i) => {
    const head = FLOW_HEADERS[i];
    const x = round1(G.padX + slotW * i + (slotW - colW) / 2);
    const list = flow.cols[col];
    const total = list.reduce((n, it) => n + it.count, 0);
    cols.push({
      key: col,
      mark: head.mark,
      title: head.title,
      sub: head.sub,
      icon: head.icon,
      total,
      x,
      y: 4,
      w: round1(colW),
      h: Math.max(G.minColH, h - 8),
    });

    // 纵向铺开（类桑基图）：节点少就拉开、多就压紧，整列居中；最多 84px 一档
    const n = list.length;
    const blockH = n > 8 ? 26 : 30;
    const rowGap = n > 8 ? 5 : 8;
    let spread = blockH + rowGap;
    if (n > 1) {
      spread = Math.min(G.maxStep, Math.max(blockH + rowGap, avail / n));
      if (spread * (n - 1) + blockH > avail) spread = Math.max(blockH + 2, (avail - blockH) / (n - 1));
    }
    const totalH = n > 1 ? spread * (n - 1) + blockH : blockH;
    const startY = top + Math.max(0, (avail - totalH) / 2);

    list.forEach((it, j) => {
      const y = round1(startY + (n > 1 ? j * spread : 0));
      // 次行：徽章优先；没有徽章时用副标题（②列的引擎版本就靠这条显示）；
      // 两者都有且放得下时合成一行（分组显示成「手动 · 4 成员」）
      const combined = it.badge && it.sub ? `${it.badge} · ${it.sub}` : '';
      const line2 =
        combined && fitText(combined, badgeUnits) === combined ? combined : it.badge || it.sub || '';
      const badge = line2 ? fitText(line2, badgeUnits) : '';
      const twoLines = !!badge && blockH >= 26;
      nodes.push({
        key: it.key,
        col,
        label: fitText(it.name, nameUnits),
        badge,
        count: it.count,
        kind: it.kind,
        icon: FLOW_ICONS[col],
        x,
        y,
        w: round1(colW),
        h: blockH,
        labelY: twoLines ? y + 12 : round1(y + blockH / 2 + 3.5),
        badgeY: twoLines ? y + 23 : 0,
        tip: it.tip || it.name,
      });
      anchors.set(it.key, { x0: x, x1: round1(x + colW), cy: round1(y + blockH / 2) });
    });
    slotAnchors.push({ x0: x, x1: round1(x + colW), cy: round1(top + avail / 2) });
  });

  // 超出一列上限的节点在 sample 路径里仍存在：按列中心兜底定位，粒子不会凭空消失
  const fallback = (key: string): FlowAnchor => slotAnchors[FLOW_COLS.indexOf(colOfKey(key))] ?? slotAnchors[0];

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
      // 结构边：浅色虚线（config 拓扑）；动态边随条数加粗加深
      opacity: e.stat ? 0.18 : round1(Math.min(0.62, 0.16 + Math.log2(1 + e.count) * 0.12)),
      width: e.stat ? 1 : round1(Math.min(3.2, 1 + Math.log2(e.count) * 0.55)),
      stat: e.stat,
    };
  });

  return { cols, nodes, edges, anchors, fallback };
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
