/**
 * flow-model.ts — 「流向」五列视图的纯函数层（无 Angular / DOM 依赖）。
 *
 * 输入是 clash_api `/connections` 的原始连接列表，输出：
 *   cols: 五列节点（①我的电脑 ②分流节点 ③节点组 ④节点 ⑤互联网）
 *   edges: 列间有向边（按 from→to 去重并累计次数）
 *   sample: 每条连接一条「列 key 路径」（粒子沿它前进）
 *
 * 布局口径（与 docs/plan-flow-anim.md 对齐）：
 *   - chains 为空 / ['DIRECT']：pc → route(DIRECT，badge「直连」) → cloud（不经过 group/node）
 *   - chains ['组A','节点X']：pc → route(组A，或 rule 给的 outbound) → group(组A) → node(节点X) → cloud
 *   - chains ['G1','G2','节点X']：组链取 'G1 › G2' 作 group 名，node=末位出站
 *   - 列内按出现次数降序（同次数按名称），最多 FLOW_MAX_PER_COL 个
 *   - 节点 key = 列前缀 + 名称（`route:DIRECT`），跨列同名互不冲突
 */
import type { Connection } from './models';

/** 五列（数组顺序即渲染顺序，粒子也按这个方向走） */
export const FLOW_COLS = ['pc', 'route', 'group', 'node', 'cloud'] as const;
export type FlowCol = (typeof FLOW_COLS)[number];

/** 节点视觉类别：直连灰 / 代理蓝 / 拦截红 */
export type FlowKind = 'direct' | 'proxy' | 'block';

/** 每列最多展示的节点数（超出的节点仍会出现在 sample 路径里，由渲染层兜底定位） */
export const FLOW_MAX_PER_COL = 10;

export interface FlowNode {
  /** 列前缀 + 名称，例：`route:DIRECT` */
  key: string;
  name: string;
  /** 小徽章：直连 / 拦截 / 手动 / 延迟排序/自动 / rule 摘要（如 `rule_set=rs-openai`） */
  badge?: string;
  /** 经过该节点的连接数 */
  count: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** 该 from→to 上累积的连接数（决定连线浓度/粗细） */
  count: number;
}

/** 一条连接的列 key 路径（粒子按它逐列走） */
export interface FlowSample {
  id: string;
  path: string[];
}

export interface FlowLayout {
  stats: {
    /** 活跃连接数 */
    total: number;
    /** 命中规则数（rule/rulePayload 去重后） */
    rules: number;
  };
  cols: {
    pc: FlowNode[];
    route: FlowNode[];
    group: FlowNode[];
    node: FlowNode[];
    cloud: FlowNode[];
  };
  edges: FlowEdge[];
  sample: FlowSample[];
}

/* ── 节点 key ── */

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

/* ── 名称 → 视觉类别 / 组类型猜测 ── */

const DIRECT_NAMES = new Set(['direct', 'direct-out', '直连']);
const BLOCK_NAMES = new Set(['block', 'reject', 'drop', 'blocked', '拦截']);

/** 出站/节点名称 → 视觉类别（DIRECT 灰、block/reject 红、其余蓝） */
export function flowKind(name: string): FlowKind {
  const n = (name ?? '').trim().toLowerCase();
  if (DIRECT_NAMES.has(n)) return 'direct';
  if (BLOCK_NAMES.has(n)) return 'block';
  return 'proxy';
}

/** 列 key → 视觉类别（供渲染层给粒子/节点着色） */
export function keyKind(key: string): FlowKind {
  return flowKind(nameOfKey(key));
}

/**
 * 一条路径的整体类别：出现 block 即红；否则出现 direct 即灰；其余蓝。
 * （pc / cloud 列的名称不参与判断，只看中间三列的出站名）
 */
export function pathKind(keys: readonly string[]): FlowKind {
  let kind: FlowKind = 'proxy';
  for (const k of keys) {
    const col = colOfKey(k);
    if (col === 'pc' || col === 'cloud') continue;
    const kk = keyKind(k);
    if (kk === 'block') return 'block';
    if (kk === 'direct') kind = 'direct';
  }
  return kind;
}

/**
 * 组类型猜测（按名字；不确定留空）。
 * URLTest 组通常叫「自动选择 / Auto / 延迟」等，Selector 组通常叫「节点选择 / 手动 / Select」等。
 */
export function guessGroupBadge(name: string): string {
  const n = (name ?? '').toLowerCase();
  if (/urltest|url-test|url_test|auto|自动|延迟|测速|fallback|故障转移/.test(n))
    return '延迟排序/自动';
  if (/select|selector|选择|手动|manual/.test(n)) return '手动';
  return '';
}

/** 规则摘要：`rule=rulePayload`（只有一侧时只取那一侧；都没有则空串） */
export function ruleSummary(c: Connection): string {
  const rule = (c.rule ?? '').trim();
  const payload = (c.rulePayload ?? '').trim();
  if (rule && payload) return `${rule}=${payload}`;
  return rule || payload;
}

/** 连接终点标签（互联网列节点名）：host / sniffHost / destinationIP，最多 32 字 */
export function destLabel(c: Connection): string {
  const m = c.metadata ?? {};
  const raw = (m.host || m.sniffHost || m.destinationIP || '').trim();
  if (!raw) return '未知目标';
  return raw.length > 32 ? raw.slice(0, 31) + '…' : raw;
}

/* ── 单条连接 → 列条目 ── */

interface ColEntry {
  col: FlowCol;
  name: string;
  badge?: string;
}

/**
 * 一条连接解析成五列条目（只用 columns 里出现的列，直连会跳过 group/node）。
 * `outbound` 不是 clash 标准字段，但部分实现（以及 sing-box 的 route action）会带上，
 * 有就以它为准作为「分流节点」列名称。
 */
export function pathOf(c: Connection): ColEntry[] {
  const chains = (c.chains ?? []).map((s) => (s ?? '').trim()).filter(Boolean);
  const rule = ruleSummary(c);
  const outbound = ((c as Connection & { outbound?: string }).outbound ?? '').trim();
  const entries: ColEntry[] = [{ col: 'pc', name: '本机' }];

  const only = chains.length === 1 ? chains[0] : '';
  const isDirect = chains.length === 0 || (!!only && flowKind(only) === 'direct');

  if (isDirect) {
    // 直连：分流节点列标 DIRECT（badge「直连」），不再经过组/节点列
    entries.push({ col: 'route', name: 'DIRECT', badge: '直连' });
  } else if (chains.length === 1) {
    // 单跳（无组）：chains 只有一项，直接就是出站本身（例如 block）
    const kind = flowKind(only);
    entries.push({ col: 'route', name: only, badge: kind === 'block' ? '拦截' : rule });
  } else {
    // 正常代理链路：chains[0..n-2] 是组链（通常只有一项），末位是真实出站节点
    const routeName = outbound || chains[0];
    const groupName = chains.slice(0, -1).join(' › ');
    entries.push({ col: 'route', name: routeName, badge: rule });
    entries.push({ col: 'group', name: groupName, badge: guessGroupBadge(chains[0]) });
    entries.push({ col: 'node', name: chains[chains.length - 1] });
  }

  entries.push({ col: 'cloud', name: destLabel(c) });
  return entries;
}

/* ── 汇聚 ── */

interface Tally {
  count: number;
  badges: Map<string, number>;
}

function bump(tallies: Map<string, Tally>, key: string, badge: string): void {
  const t = tallies.get(key);
  if (t) {
    t.count++;
    if (badge) t.badges.set(badge, (t.badges.get(badge) ?? 0) + 1);
    return;
  }
  const badges = new Map<string, number>();
  if (badge) badges.set(badge, 1);
  tallies.set(key, { count: 1, badges });
}

/** 节点最终徽章：取出现最多的那条（同次数取字典序小的，保证输出稳定） */
function topBadge(badges: Map<string, number>): string | undefined {
  let best = '';
  let bestN = -1;
  for (const [b, n] of badges) {
    if (n > bestN || (n === bestN && b < best)) {
      best = b;
      bestN = n;
    }
  }
  return best || undefined;
}

/** 名称比较：代码点序（稳定、与运行环境的 locale 无关） */
function cmpName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 列 → 排序后的节点数组（次数降序、同次数名称升序、最多 FLOW_MAX_PER_COL 个） */
function toNodes(tallies: Map<string, Tally>): FlowNode[] {
  const list: FlowNode[] = [];
  for (const [key, t] of tallies) {
    list.push({ key, name: nameOfKey(key), badge: topBadge(t.badges), count: t.count });
  }
  list.sort((a, b) => b.count - a.count || cmpName(a.name, b.name));
  return list.slice(0, FLOW_MAX_PER_COL);
}

/**
 * 连接列表 → 五列布局。
 * 空列表时仍保留 ①「本机」节点（count 0），其余列空。
 */
export function buildFlow(conns: Connection[]): FlowLayout {
  const tallies: Record<FlowCol, Map<string, Tally>> = {
    pc: new Map(),
    route: new Map(),
    group: new Map(),
    node: new Map(),
    cloud: new Map(),
  };
  const edges = new Map<string, FlowEdge>();
  const sample: FlowSample[] = [];
  const rules = new Set<string>();
  let total = 0;

  for (const c of conns) {
    const entries = pathOf(c);
    const keys = entries.map((e) => nodeKey(e.col, e.name));
    total++;
    const rule = ruleSummary(c);
    if (rule) rules.add(rule);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      bump(tallies[e.col], keys[i], e.badge ?? '');
      if (i + 1 >= entries.length) continue;
      const from = keys[i];
      const to = keys[i + 1];
      const ek = `${from}\u0000${to}`;
      const prev = edges.get(ek);
      if (prev) prev.count++;
      else edges.set(ek, { from, to, count: 1 });
    }

    sample.push({ id: c.id, path: keys });
  }

  // 空数据也保留 ①「本机」（count 0），避免整列塌成空画布
  if (!tallies.pc.size) tallies.pc.set(nodeKey('pc', '本机'), { count: 0, badges: new Map() });

  const edgeList = [...edges.values()];
  edgeList.sort((a, b) => b.count - a.count || cmpName(a.from, b.from) || cmpName(a.to, b.to));

  return {
    stats: { total, rules: rules.size },
    cols: {
      pc: toNodes(tallies.pc),
      route: toNodes(tallies.route),
      group: toNodes(tallies.group),
      node: toNodes(tallies.node),
      cloud: toNodes(tallies.cloud),
    },
    edges: edgeList,
    sample,
  };
}
