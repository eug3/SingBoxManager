/**
 * connections-model.ts — 连接子页的纯逻辑层（不碰 DOM，便于单测与复用）。
 *
 * 口径对齐 zashboard /ui/#/connections：
 *  - 三档视图：活跃 / 已关闭 / 全部；「已关闭」由相邻两次快照做差得到（clash_api 只回活跃连接）；
 *  - 搜索即正则：空格分隔的每个词都是独立正则，词之间 AND、同一行的字段之间 OR（不区分大小写）；
 *  - 快速隐藏：一条正则（默认 direct|dns-out）把命中行整行藏掉，命中数单独统计；
 *  - 列头排序：任意列升降序；数值列按原始数值排（不按格式化后的字符串）；
 *  - 按列分组：源 IP / 规则 / 出口 / 链 / 网络 / 入站 / 主机 / 进程，组内仍可排序。
 *
 * 本层只依赖 models 的 Connection 与 util 的格式化，视图只做渲染与事件。
 */
import type { Connection, ConnMeta } from './models';
import { ageText, clockText, fmtBytes, fmtRate } from './util';

/* ── 列定义 ── */

/** 表格列 key（顺序即默认列序） */
export type ConnCol =
  | 'close'
  | 'host'
  | 'net'
  | 'type'
  | 'rule'
  | 'chains'
  | 'outbound'
  | 'src'
  | 'dst'
  | 'process'
  | 'dns'
  | 'age'
  | 'idle'
  | 'dlSpd'
  | 'ulSpd'
  | 'dl'
  | 'ul'
  | 'start';

/** 可搜索的文本字段（搜索范围 / 快速隐藏都在这套字段上匹配） */
export type ConnField =
  'host' | 'net' | 'type' | 'rule' | 'chains' | 'outbound' | 'src' | 'dst' | 'process' | 'dns';

/** 列定义：text = 该列的搜索字段；num = 数值列（首次点击按降序）；w = 默认列宽提示 */
export interface ColDef {
  key: ConnCol;
  label: string;
  tip: string;
  text?: ConnField;
  num?: boolean;
  w?: number;
}

/** 全部列（顺序即「恢复默认」之外的可选池顺序） */
export const COLS: ColDef[] = [
  { key: 'close', label: '断开', tip: '断开这一条连接（已关闭的连接不再显示按钮）', w: 36 },
  {
    key: 'host',
    label: '主机',
    tip: 'metadata.host → sniffHost → 目标 IP 依次兜底',
    text: 'host',
    w: 200,
  },
  { key: 'net', label: '网络', tip: 'metadata.network：tcp / udp', text: 'net', w: 46 },
  {
    key: 'type',
    label: '入站',
    tip: 'metadata.type：命中该连接的入站类型（tun/tun-in、mixed-in…）',
    text: 'type',
    w: 92,
  },
  {
    key: 'rule',
    label: '规则',
    tip: '命中的分流规则（sing-box 口径：rule_set=… => route(…)）',
    text: 'rule',
    w: 200,
  },
  {
    key: 'chains',
    label: '链',
    tip: '代理链：出口节点 → 分组（可在列设置里翻转为「分组 → 出口」）',
    text: 'chains',
    w: 220,
  },
  {
    key: 'outbound',
    label: '出口',
    tip: 'chains[0]，实际承载这条连接的出站',
    text: 'outbound',
    w: 110,
  },
  {
    key: 'src',
    label: '来源',
    tip: 'metadata.sourceIP:sourcePort（TUN 模式为内网源地址）',
    text: 'src',
    num: false,
    w: 150,
  },
  { key: 'dst', label: '目标', tip: 'metadata.destinationIP:destinationPort', text: 'dst', w: 150 },
  {
    key: 'process',
    label: '进程',
    tip: 'metadata.processPath / process（TUN 模式下通常为空）',
    text: 'process',
    w: 120,
  },
  { key: 'dns', label: 'DNS', tip: 'metadata.dnsMode：normal / fakeip …', text: 'dns', w: 64 },
  {
    key: 'age',
    label: '存活',
    tip: '连接存活的时长（点击列头可按存活排序，用来揪僵死）',
    num: true,
    w: 68,
  },
  {
    key: 'idle',
    label: '空转',
    tip: '距最近一次字节增长的时间；<60s 显示 —（长时间空转 = 疑似僵死）',
    num: true,
    w: 68,
  },
  { key: 'dlSpd', label: '↓速率', tip: '两次快照之间下载字节的增量 / 间隔', num: true, w: 78 },
  { key: 'ulSpd', label: '↑速率', tip: '两次快照之间上传字节的增量 / 间隔', num: true, w: 78 },
  { key: 'dl', label: '↓累计', tip: '这条连接累计下载字节', num: true, w: 78 },
  { key: 'ul', label: '↑累计', tip: '这条连接累计上传字节', num: true, w: 78 },
  { key: 'start', label: '开始', tip: '连接建立时刻（本地时间 HH:MM:SS）', num: true, w: 78 },
];

/** key → 列定义 */
export const COL_BY_KEY: Record<ConnCol, ColDef> = COLS.reduce(
  (m, c) => ((m[c.key] = c), m),
  {} as Record<ConnCol, ColDef>,
);

/** 默认显示的列（与旧表格口径一致，另加两列速率） */
export const DEFAULT_COLS: ConnCol[] = [
  'close',
  'host',
  'net',
  'rule',
  'chains',
  'age',
  'idle',
  'dlSpd',
  'ulSpd',
  'dl',
  'ul',
];

/* ── 连接字段读取口径（展示与搜索共用同一套兜底） ── */

export function metaOf(c: Connection): ConnMeta {
  return c.metadata ?? {};
}

/** 主机名：host → sniffHost → 目标 IP */
export function hostOf(c: Connection): string {
  const m = metaOf(c);
  return m.host || m.sniffHost || m.destinationIP || '';
}

/** 来源 IP（筛选与分组用这个口径，端口不参与） */
export function srcIpOf(c: Connection): string {
  return metaOf(c).sourceIP || '';
}

/** 来源地址（表格里显示 ip:port） */
export function srcOf(c: Connection): string {
  const m = metaOf(c);
  const ip = m.sourceIP || '';
  if (!ip) return '';
  return m.sourcePort ? `${ip}:${m.sourcePort}` : ip;
}

/** 目标 IP[:端口]（缺 IP 时回落主机名） */
export function destOf(c: Connection): string {
  const m = metaOf(c);
  const ip = m.destinationIP || '';
  if (!ip) return hostOf(c);
  return m.destinationPort ? `${ip}:${m.destinationPort}` : ip;
}

/** 规则文案：rule（有 payload 才拼在后面，sing-box 1.15 起 rule 已是完整表达式） */
export function ruleOf(c: Connection): string {
  const r = (c.rule || '').trim();
  const p = (c.rulePayload || '').trim();
  return r && p ? `${r}: ${p}` : r || p;
}

/**
 * 规则短文案：把 sing-box 的完整表达式压成「条件 ⇒ 出站」再放进表格，
 * 完整原文留在单元格 title 与详情抽屉里（例：rule_set=cn_ip => route(DIRECT) → cn_ip ⇒ DIRECT）。
 */
export function ruleShort(c: Connection): string {
  const full = ruleOf(c);
  if (!full) return '';
  const m = /^(.*?)\s*(?:=>|:)\s*route\((.+?)\)\s*$/.exec(full);
  if (!m) return full;
  const cond = m[1].replace(/^rule_set=/, '');
  return `${cond} ⇒ ${m[2]}`;
}

/** 代理链（sing-box 原始顺序：出口节点 → … → 分组） */
export function chainsOf(c: Connection): string[] {
  return c.chains ?? [];
}

/** 实际出口（chains[0]） */
export function outOf(c: Connection): string {
  return chainsOf(c)[0] || '';
}

/** start（ISO 串）→ 毫秒时间戳；解析失败记 0 */
export function startMsOf(c: Connection): number {
  const t = Date.parse(c.start);
  return Number.isFinite(t) ? t : 0;
}

/* ── 快照追踪：速率 / 空转 / 已关闭 ── */

/** 视图里的一行：原始连接 + 由快照差分得到的动态量 */
export interface ConnRow {
  c: Connection;
  /** 已经不在活跃快照里（保留在「已关闭 / 全部」视图） */
  closed: boolean;
  /** 连接建立时刻（毫秒） */
  startMs: number;
  /** 最近一次出现在快照里的时刻（算速率的时间基准） */
  lastSeen: number;
  /** 最近一次字节增长的时刻（算空转的时间基准） */
  moveAt: number;
  /** 上次快照的累计字节 */
  dl: number;
  ul: number;
  /** 两次快照之间的速率（字节/秒） */
  dlSpd: number;
  ulSpd: number;
  /** 搜索字段（原文，不转小写：正则带 i 标志） */
  f: Record<ConnField, string>;
  /** 全字段拼接（快速隐藏正则用） */
  all: string;
}

/** 存活秒数：活跃连接算到此刻，已关闭的冻结在最后一次看到它的时刻（= 实际存活时长） */
export function ageSec(row: ConnRow, now: number): number {
  if (!row.startMs) return 0;
  const end = row.closed ? row.lastSeen : now;
  return Math.max(0, (end - row.startMs) / 1000);
}

/** 空转秒数：距最近一次字节增长（已关闭连接冻结在最后一次看到时） */
export function idleSec(row: ConnRow, now: number): number {
  const t = row.closed ? row.lastSeen : now;
  return Math.max(0, (t - row.moveAt) / 1000);
}

/** 建一行的搜索字段 */
function fieldsOf(c: Connection): Record<ConnField, string> {
  const m = metaOf(c);
  return {
    host: hostOf(c),
    net: m.network || '',
    type: m.type || '',
    rule: ruleOf(c),
    chains: chainsOf(c).join(' '),
    outbound: outOf(c),
    src: srcIpOf(c),
    dst: destOf(c),
    process: m.processPath || m.process || '',
    dns: m.dnsMode || '',
  };
}

/** 已关闭连接在内存里保留的最大条数（与 zashboard 一致的 500） */
export const CLOSED_LIMIT = 500;

/**
 * 快照追踪器：每次 apply 传入最新活跃快照，返回「活跃 + 已关闭」全量行。
 *  - 速率 = 本次累计字节 − 上次累计字节 / 间隔（计数回绕或重建时按 0）；
 *  - 字节有增长 → 刷新 moveAt（空转归零）；
 *  - 上一轮活跃、这一轮消失 → 记为已关闭（保留 500 条，最旧的丢弃）。
 */
export class ConnTracker {
  private rows = new Map<string, ConnRow>();

  reset(): void {
    this.rows = new Map();
  }

  apply(list: readonly Connection[], now: number): ConnRow[] {
    const incoming = new Set<string>();
    const active: ConnRow[] = [];
    const next = new Map<string, ConnRow>();

    for (const c of list) {
      incoming.add(c.id);
      const dl = c.download ?? 0;
      const ul = c.upload ?? 0;
      const prev = this.rows.get(c.id);
      const f = fieldsOf(c);
      const all = Object.values(f).join(' ');
      let row: ConnRow;
      if (prev && !prev.closed) {
        // 间隔下限 0.2s：轮询抖动时避免把速率放大成一瞬间的尖峰
        const dt = Math.max(0.2, (now - prev.lastSeen) / 1000);
        const dDl = dl - prev.dl;
        const dUl = ul - prev.ul;
        const moved = dDl > 0 || dUl > 0;
        row = {
          c,
          closed: false,
          startMs: startMsOf(c),
          lastSeen: now,
          moveAt: moved ? now : prev.moveAt,
          dl,
          ul,
          dlSpd: dDl > 0 ? dDl / dt : 0,
          ulSpd: dUl > 0 ? dUl / dt : 0,
          f,
          all,
        };
      } else {
        // 首次出现：速率从 0 起算，空转也从现在起算
        row = {
          c,
          closed: false,
          startMs: startMsOf(c),
          lastSeen: now,
          moveAt: now,
          dl,
          ul,
          dlSpd: 0,
          ulSpd: 0,
          f,
          all,
        };
      }
      next.set(c.id, row);
      active.push(row);
    }

    // 本轮消失的活跃连接 → 已关闭（速率归零，空转冻结）
    const closd: ConnRow[] = [];
    for (const [id, prev] of this.rows) {
      if (incoming.has(id) || prev.closed) continue;
      closd.push({ ...prev, closed: true, lastSeen: now, dlSpd: 0, ulSpd: 0 });
    }
    // 旧的已关闭连接原样保留，与新关闭的合起来按最近可见时间排序截断
    const kept: ConnRow[] = [];
    for (const prev of this.rows.values()) if (prev.closed) kept.push(prev);
    const allClosed = [...closd, ...kept]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, CLOSED_LIMIT);
    for (const r of allClosed) next.set(r.c.id, r);

    this.rows = next;
    return [...active, ...allClosed];
  }
}

/* ── 搜索（正则）与命中高亮 ── */

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * 搜索词 → 正则数组：空格分隔的每个词单独编译（不区分大小写）。
 * 非法正则（如未闭合括号）自动降级成同字面量的转义匹配，不让整页搜索失效。
 */
export function parseSearch(q: string): RegExp[] {
  const raw = (q || '').trim();
  if (!raw) return [];
  const regs: RegExp[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok) continue;
    try {
      regs.push(new RegExp(tok, 'i'));
    } catch {
      regs.push(new RegExp(tok.replace(ESCAPE_RE, '\\$&'), 'i'));
    }
  }
  return regs;
}

/** 命中片段：t=文本，m=是否命中 */
export interface HlPart {
  t: string;
  m: boolean;
}

/** 把文本按正则切成「命中 / 未命中」片段（重叠区间合并）；无正则时返回 null（视图直接显示原文） */
export function highlightParts(text: string, regs: RegExp[]): HlPart[] | null {
  if (!regs.length || !text) return null;
  const ranges: [number, number][] = [];
  for (const re of regs) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      if (m[0].length) ranges.push([m.index, m.index + m[0].length]);
      if (!m[0].length) g.lastIndex += 1; // 零宽匹配防死循环
    }
  }
  if (!ranges.length) return [{ t: text, m: false }];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (!last || r[0] > last[1]) merged.push([r[0], r[1]]);
    else last[1] = Math.max(last[1], r[1]);
  }
  const parts: HlPart[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) parts.push({ t: text.slice(cursor, s), m: false });
    parts.push({ t: text.slice(s, e), m: true });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ t: text.slice(cursor), m: false });
  return parts;
}

/* ── 视图文案 ── */

/** 链标签：full=false 时把 >2 段折叠成「出口 › … › 分组」；dir=in 时翻转为「分组 › … › 出口」 */
export function chainTags(
  row: ConnRow,
  dir: 'out' | 'in',
  full: boolean,
): { name: string; out: boolean }[] {
  const raw = chainsOf(row.c);
  if (!raw.length) return [];
  let list: { name: string; out: boolean }[];
  if (full || raw.length <= 2) {
    list = raw.map((name, i) => ({ name, out: i === 0 }));
  } else {
    list = [
      { name: raw[0], out: true },
      { name: '…', out: false },
      { name: raw[raw.length - 1], out: false },
    ];
  }
  return dir === 'in' ? list.reverse() : list;
}

/** 单元格文案（表格、搜索高亮、右键复制共用一套；close 列无文案） */
export function cellText(row: ConnRow, key: ConnCol, now: number, full = true): string {
  const m = metaOf(row.c);
  switch (key) {
    case 'close':
      return '';
    case 'host':
      return hostOf(row.c) || '—';
    case 'net':
      return m.network || '—';
    case 'type':
      return m.type || '—';
    case 'rule':
      return ruleShort(row.c) || '—';
    case 'chains':
      return chainTags(row, 'out', full)
        .map((t) => t.name)
        .join(' › ');
    case 'outbound':
      return outOf(row.c) || '—';
    case 'src':
      return srcOf(row.c) || '—';
    case 'dst':
      return destOf(row.c) || '—';
    case 'process':
      return m.processPath || m.process || '—';
    case 'dns':
      return m.dnsMode || '—';
    case 'age':
      return ageText(ageSec(row, now));
    case 'idle':
      // 与旧表格口径一致：<60s 不打扰，显示 —
      return row.closed ? '—' : idleSec(row, now) >= 60 ? ageText(idleSec(row, now)) : '—';
    case 'start':
      return clockText(row.c.start) || '—';
    case 'dlSpd':
      return row.dlSpd > 0 ? fmtRate(row.dlSpd) : '—';
    case 'ulSpd':
      return row.ulSpd > 0 ? fmtRate(row.ulSpd) : '—';
    case 'dl':
      return fmtBytes(row.dl);
    case 'ul':
      return fmtBytes(row.ul);
  }
}

/* ── 排序 ── */

export type SortDir = 'asc' | 'desc';

/** 排序状态（null = 保持快照顺序） */
export interface SortState {
  key: ConnCol;
  dir: SortDir;
}

/** 某列的排序值：数值列给数字、文本列给字符串（空值排最后由比较器兜底） */
export function sortValue(row: ConnRow, key: ConnCol, now: number): string | number {
  switch (key) {
    case 'age':
      return ageSec(row, now);
    case 'idle':
      return row.closed ? -1 : idleSec(row, now);
    case 'dlSpd':
      return row.dlSpd;
    case 'ulSpd':
      return row.ulSpd;
    case 'dl':
      return row.dl;
    case 'ul':
      return row.ul;
    case 'start':
      return row.startMs;
    case 'close':
      return 0;
    default:
      return cellText(row, key, now);
  }
}

/** 按列排序（同值时按 id 稳定兜底；不改变传入数组） */
export function sortRows(rows: readonly ConnRow[], sort: SortState | null, now: number): ConnRow[] {
  if (!sort) return rows as ConnRow[];
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key, now);
    const vb = sortValue(b, sort.key, now);
    let r: number;
    if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
    else r = String(va).localeCompare(String(vb), 'zh-Hans-CN', { numeric: true });
    if (r === 0) r = a.c.id.localeCompare(b.c.id);
    return r * mul;
  });
}

/* ── 筛选 ── */

/** 筛选条件（由视图的状态拼出来，纯数据） */
export interface ConnFilter {
  /** 搜索正则（AND） */
  regs: RegExp[];
  /** 搜索范围：可见文本列的字段；空 = 全部字段 */
  scope: ConnField[];
  /** 快速隐藏正则（命中全字段即整行藏掉） */
  hide: RegExp[];
  /** 源 IP 多选（空 = 不过滤） */
  src: ReadonlySet<string>;
  /** 网络类型过滤 */
  net: '' | 'tcp' | 'udp';
  /** 出口过滤（chains[0]，空 = 不过滤） */
  outbound: string;
  /** 存活下限（秒，0 = 不过滤） */
  minAge: number;
  /** 只看空转 ≥60s 的行 */
  idleOnly: boolean;
  now: number;
}

/** 筛选结果：命中行 + 被快速隐藏正则藏掉的条数 */
export interface FilterResult {
  rows: ConnRow[];
  hidden: number;
}

/** 依次套用：快速隐藏 → 源 IP → 网络 → 出口 → 存活 → 空转 → 搜索 */
export function applyFilters(rows: readonly ConnRow[], f: ConnFilter): FilterResult {
  const out: ConnRow[] = [];
  let hidden = 0;
  for (const r of rows) {
    if (f.hide.length && f.hide.some((re) => re.test(r.all))) {
      hidden++;
      continue;
    }
    if (f.src.size && !f.src.has(r.f.src)) continue;
    if (f.net && (metaOf(r.c).network || '') !== f.net) continue;
    if (f.outbound && outOf(r.c) !== f.outbound) continue;
    if (f.minAge > 0 && ageSec(r, f.now) < f.minAge) continue;
    if (f.idleOnly && idleSec(r, f.now) < 60) continue;
    if (f.regs.length) {
      const vals = f.scope.length ? f.scope.map((k) => r.f[k]) : Object.values(r.f);
      if (!f.regs.every((re) => vals.some((v) => re.test(v)))) continue;
    }
    out.push(r);
  }
  return { rows: out, hidden };
}

/* ── 分组 ── */

/** 可分组字段（对应表头/工具条的分组下拉） */
export const GROUP_KEYS = [
  'src',
  'rule',
  'outbound',
  'chains',
  'net',
  'type',
  'host',
  'process',
] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

/** 分组下拉的文案 */
export const GROUP_LABELS: Record<GroupKey, string> = {
  src: '源 IP',
  rule: '规则',
  outbound: '出口',
  chains: '链',
  net: '网络',
  type: '入站',
  host: '主机',
  process: '进程',
};

/** 一组的聚合：行、累计字节、最老存活（用于组头摘要） */
export interface ConnGroup {
  key: string;
  label: string;
  rows: ConnRow[];
  dl: number;
  ul: number;
  oldest: number;
}

/** 按字段分组；组间按条数降序，组内沿用已排序的先后 */
export function groupRows(
  rows: readonly ConnRow[],
  by: GroupKey,
  now: number,
  label: (row: ConnRow) => string,
): ConnGroup[] {
  const map = new Map<string, ConnGroup>();
  for (const r of rows) {
    const k = r.f[by] || '（空）';
    let g = map.get(k);
    if (!g) {
      g = { key: k, label: label(r) || '（空）', rows: [], dl: 0, ul: 0, oldest: 0 };
      map.set(k, g);
    }
    g.rows.push(r);
    g.dl += r.dl;
    g.ul += r.ul;
    g.oldest = Math.max(g.oldest, ageSec(r, now));
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/* ── 汇总统计 ── */

export interface ConnStat {
  count: number;
  /** 存活 ≥5 分钟的老连接数 */
  old: number;
  /** 其中空转 ≥1 分钟的（最可能的僵死候选） */
  idleOld: number;
  /** 最老存活（秒） */
  oldest: number;
  /** 累计 / 实时速率 */
  dl: number;
  ul: number;
  dlSpd: number;
  ulSpd: number;
}

/** 一批行的汇总（状态条用） */
export function sumStat(rows: readonly ConnRow[], now: number): ConnStat {
  const s: ConnStat = { count: 0, old: 0, idleOld: 0, oldest: 0, dl: 0, ul: 0, dlSpd: 0, ulSpd: 0 };
  for (const r of rows) {
    s.count++;
    const a = ageSec(r, now);
    if (a > s.oldest) s.oldest = a;
    if (!r.closed && a >= 300) {
      s.old++;
      if (idleSec(r, now) >= 60) s.idleOld++;
    }
    s.dl += r.dl;
    s.ul += r.ul;
    s.dlSpd += r.dlSpd;
    s.ulSpd += r.ulSpd;
  }
  return s;
}

/** 某字段的去重计数（源 IP / 出口下拉的候选与徽章） */
export function countBy(
  rows: readonly ConnRow[],
  field: ConnField,
): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r.f[field];
    if (v) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) =>
        b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN', { numeric: true }),
    );
}
