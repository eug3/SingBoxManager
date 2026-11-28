import { Injectable, signal } from '@angular/core';
import { AnyObj, ConfigDoc, endpoints, outbounds, routeRules } from './config-ops';

/** 节点所在的顶层数组：普通出站 or endpoints（masque-client 等） */
export type PoolKind = 'outbound' | 'endpoint';

/** 共享池里的一个节点条目 */
export interface PoolNode {
  /** 池内唯一 id（随机） */
  id: string;
  /** 来源后端 api（同一后端重复加入会覆盖同 tag 的旧条目） */
  sourceApi: string;
  /** 来源后端的显示名（列表里标注「来自 32」） */
  sourceName: string;
  /** 原始 tag（导入到别的路由时可能被加上来源前缀） */
  tag: string;
  /** 来自 outbounds 还是 endpoints（导入时原样放回同名数组；老数据默认 outbound） */
  kind: PoolKind;
  /** 完整出站对象（保留 server/密钥/tls/transport 等全部字段） */
  node: AnyObj;
  /** 加入时间（ms） */
  addedAt: number;
}

/**
 * 共享规则池的一条：某个「组名（出站 tag）」下挂的整套 rule_set 引用。
 *
 * 规则池**不关心这条来自谁**——只认「组名 → 同一套规则集」。
 * 每条有自己的状态：
 *   · applied（已应用）= 所有路由器的该组名都已采用这套规则集；
 *   · 未 applied（未应用）= 各路由仍各自独立管理这一组。
 */
export interface PoolRules {
  id: string;
  /** 组名 / 出站 tag（如 🚀 节点选择）；目标路由只要有同名出口即可套用 */
  group: string;
  /** 这套组名用到的 rule_set 引用（顺序保留；去重后的并集） */
  refs: string[];
  /** 是否已应用到所有路由器（true = 已应用；false/缺省 = 未应用） */
  applied?: boolean;
  /** 最近一次确认/应用成功的时间（ms） */
  appliedAt?: number;
  /** 建立时的来源（仅作日志留痕，界面不再展示「来自 X」） */
  originName?: string;
  addedAt: number;
}

interface PoolState {
  version: 2;
  nodes: PoolNode[];
  rules: PoolRules[];
}

/** 稳定序列化（键排序），用于判断「同配置」 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableJson(o[k]))
      .join(',') +
    '}'
  );
}

/**
 * 节点「配置指纹」：去掉 tag 后的稳定 JSON。
 * 池子里已有同指纹的节点 = 这台路由上这个节点的配置已经在共享池里了 → 列表里打 share 标记、禁止再拖。
 */
export function nodeFingerprint(node: AnyObj, kind: PoolKind = 'outbound'): string {
  const { tag: _tag, ...rest } = node as Record<string, unknown>;
  return kind + '|' + stableJson(rest);
}

const KEY = 'sbm.sharedPool.v2';
const KEY_V1 = 'sbm.sharedPool.v1';

/**
 * 共享池 — 跨后端的「可复用配置元素」仓库。
 *
 * 现在只放**节点（出站）**：把 A 路由的节点拖进池子，切到 B 路由「新增节点 → 共享池」
 * 就能一键导入（tag 冲突自动加来源前缀），不必两台路由各配一遍。
 *
 * 存储：浏览器 localStorage（同一浏览器里两个后端共用）。服务端（NAS/99）落盘需要改 Go 服务，
 * 先给导出/导入 JSON 兜底，换设备时手动搬一次即可。
 */
@Injectable({ providedIn: 'root' })
export class SharedPoolService {
  readonly nodes = signal<PoolNode[]>([]);
  readonly rules = signal<PoolRules[]>([]);

  constructor() {
    const st = this.load();
    this.nodes.set(st.nodes);
    this.rules.set(st.rules);
  }

  private load(): { nodes: PoolNode[]; rules: PoolRules[] } {
    const empty = { nodes: [] as PoolNode[], rules: [] as PoolRules[] };
    try {
      const raw = localStorage.getItem(KEY) ?? localStorage.getItem(KEY_V1);
      if (!raw) return empty;
      const st = JSON.parse(raw) as Partial<PoolState> & { version?: number };
      const nodes = Array.isArray(st.nodes)
        ? st.nodes
            .filter((n) => n && typeof n.tag === 'string' && n.node && typeof n.node === 'object')
            .map((n) => ({ ...n, kind: n.kind === 'endpoint' ? 'endpoint' : 'outbound' }) as PoolNode)
        : [];
      const rules = Array.isArray(st.rules)
        ? (st.rules as Partial<PoolRules>[])
            .filter((r) => r && typeof r.group === 'string' && Array.isArray(r.refs))
            .map((r) => ({
              id: r.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              group: r.group as string,
              refs: r.refs as string[],
              applied: r.applied === true,
              appliedAt: r.appliedAt,
              originName: r.originName ?? (r as { sourceName?: string }).sourceName,
              addedAt: r.addedAt || Date.now(),
            }))
        : [];
      return { nodes, rules };
    } catch {
      return empty;
    }
  }

  private save(next: { nodes?: PoolNode[]; rules?: PoolRules[] } = {}): void {
    const nodes = next.nodes ?? this.nodes();
    const rules = next.rules ?? this.rules();
    this.nodes.set(nodes);
    this.rules.set(rules);
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 2, nodes, rules } satisfies PoolState));
      localStorage.removeItem(KEY_V1);
    } catch {
      /* 隐私模式写不进去：内存里仍有，本会话可用 */
    }
  }

  /** 加入池子：同一来源 + 同 tag 视为同一条（覆盖旧内容）；返回是否新加入 */
  addNode(
    source: { api: string; name: string },
    node: AnyObj,
    kind: PoolKind = 'outbound',
  ): { ok: boolean; dup: boolean; reason?: string } {
    const tag = String(node['tag'] ?? '').trim();
    if (!tag) return { ok: false, dup: false, reason: '节点没有 tag，无法共享' };
    const type = String(node['type'] ?? '');
    if (!type || type === 'selector' || type === 'urltest' || type === 'direct' || type === 'block') {
      return { ok: false, dup: false, reason: '只能共享节点（分组 / 内置出站不参与）' };
    }
    const list = this.nodes();
    const same = list.find((n) => n.sourceApi === source.api && n.tag === tag);
    const entry: PoolNode = {
      id: same?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sourceApi: source.api,
      sourceName: source.name || source.api,
      tag,
      kind,
      node: structuredClone(node),
      addedAt: Date.now(),
    };
    this.save({ nodes: same ? list.map((n) => (n.id === same.id ? entry : n)) : [entry, ...list] });
    return { ok: true, dup: !!same };
  }

  /** 编辑池里的节点（整体替换 JSON；tag 改了也允许，同来源同 tag 的去重口径不变） */
  updateNode(id: string, node: AnyObj): { ok: boolean; reason?: string } {
    const tag = String(node['tag'] ?? '').trim();
    const type = String(node['type'] ?? '');
    if (!tag) return { ok: false, reason: '节点必须有 tag' };
    if (!type) return { ok: false, reason: '节点必须有 type' };
    const list = this.nodes();
    const cur = list.find((n) => n.id === id);
    if (!cur) return { ok: false, reason: '池里找不到这条' };
    const clash = list.find((n) => n.id !== id && n.sourceApi === cur.sourceApi && n.tag === tag);
    if (clash) return { ok: false, reason: `同来源已有同名 tag「${tag}」` };
    this.save({ nodes: list.map((n) => (n.id === id ? { ...n, tag, node: structuredClone(node) } : n)) });
    return { ok: true };
  }

  removeNode(id: string): void {
    this.save({ nodes: this.nodes().filter((n) => n.id !== id) });
  }

  clear(): void {
    this.save({ nodes: [], rules: [] });
  }

  /* ── 共享规则池：组名 → 整套 rule_set 引用 ── */

  /** 按组名查（规则池不区分来源：一个组名只有一条） */
  ruleByGroup(group: string): PoolRules | undefined {
    return this.rules().find((r) => r.group === group);
  }

  /**
   * 把「组名 + 它挂的全部规则集」加入规则池。
   * 规则池不关心来源：同一个组名只有一条，重复加入 = 更新它的 refs 并回到「未应用」。
   */
  addRuleGroup(
    group: string,
    refs: string[],
    origin?: { api: string; name: string },
  ): { ok: boolean; dup: boolean; reason?: string } {
    const g = String(group ?? '').trim();
    if (!g) return { ok: false, dup: false, reason: '没有组名，无法共享' };
    if (!refs.length) return { ok: false, dup: false, reason: '这个组名没有挂规则集，没什么可共享的' };
    const list = this.rules();
    const same = list.find((r) => r.group === g);
    const entry: PoolRules = {
      id: same?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      group: g,
      refs: [...new Set(refs)],
      applied: false,
      appliedAt: undefined,
      originName: origin?.name || origin?.api || same?.originName,
      addedAt: same?.addedAt ?? Date.now(),
    };
    this.save({ rules: same ? list.map((r) => (r.id === same.id ? entry : r)) : [entry, ...list] });
    return { ok: true, dup: !!same };
  }

  /** 编辑规则条目的规则集引用（组名不变）。改完回到「未应用」——需再同步一次才能让各路由跟上 */
  updateRuleRefs(id: string, refs: string[]): { ok: boolean; reason?: string } {
    const list = [...new Set(refs.map((x) => String(x).trim()).filter(Boolean))];
    if (!list.length) return { ok: false, reason: '至少保留一个规则集' };
    const cur = this.rules().find((r) => r.id === id);
    if (!cur) return { ok: false, reason: '池里找不到这条' };
    const same = sameRefSet(cur.refs, list);
    this.save({
      rules: this.rules().map((r) =>
        r.id === id ? { ...r, refs: list, applied: same ? r.applied : false, appliedAt: same ? r.appliedAt : undefined } : r,
      ),
    });
    return { ok: true };
  }

  /** 设置某条规则的「已应用 / 未应用」状态 */
  setRuleApplied(id: string, applied: boolean): void {
    this.save({
      rules: this.rules().map((r) =>
        r.id === id ? { ...r, applied, appliedAt: applied ? Date.now() : undefined } : r,
      ),
    });
  }

  removeRule(id: string): void {
    this.save({ rules: this.rules().filter((r) => r.id !== id) });
  }

  /** 规则池列表：按「未应用优先、再按组名」排（不按来源分组） */
  rulesList(): PoolRules[] {
    return [...this.rules()].sort((a, b) => {
      const x = a.applied === true ? 1 : 0;
      const y = b.applied === true ? 1 : 0;
      return x === y ? a.group.localeCompare(b.group) : x - y;
    });
  }

  /** 已应用 / 未应用计数（页签徽标与总览用） */
  rulesStats(): { applied: number; pending: number } {
    const all = this.rules();
    const applied = all.filter((r) => r.applied === true).length;
    return { applied, pending: all.length - applied };
  }

  /** 池内所有节点的指纹集合（判断「路由上已有同配置」用） */
  fingerprints(): Set<string> {
    return new Set(this.nodes().map((n) => nodeFingerprint(n.node, n.kind)));
  }

  /** 按来源分组（面板展示用） */
  bySource(): { sourceName: string; sourceApi: string; items: PoolNode[] }[] {
    const map = new Map<string, { sourceName: string; sourceApi: string; items: PoolNode[] }>();
    for (const n of this.nodes()) {
      const key = n.sourceApi;
      const g = map.get(key) ?? { sourceName: n.sourceName, sourceApi: n.sourceApi, items: [] };
      g.items.push(n);
      map.set(key, g);
    }
    return [...map.values()];
  }

  /**
   * 给导入的节点取一个不冲突的 tag：
   * 原 tag 没被占用就用原 tag；否则 `<来源>-<tag>`；还冲突就 -2/-3…
   */
  uniqueTagFor(doc: ConfigDoc | null, tag: string, sourceName: string): string {
    const used = new Set(
      doc ? [...outbounds(doc), ...endpoints(doc)].map((o) => String(o['tag'] ?? '')) : [],
    );
    if (!used.has(tag)) return tag;
    const prefix = (sourceName || 'pool').replace(/\s+/g, '-');
    let cand = `${prefix}-${tag}`;
    let n = 2;
    while (used.has(cand)) {
      cand = `${prefix}-${tag}-${n}`;
      n += 1;
    }
    return cand;
  }

  /**
   * 把池里的节点导入文档（保留原对象全部字段；tag 冲突自动改名）。
   * endpoints（masque-client 等）原样放回 `endpoints`，普通节点放回 `outbounds`。
   * 返回最终 tag。
   */
  importInto(doc: ConfigDoc, item: PoolNode): string {
    const tag = this.uniqueTagFor(doc, item.tag, item.sourceName);
    const node: AnyObj = { ...structuredClone(item.node), tag };
    const key = item.kind === 'endpoint' ? 'endpoints' : 'outbounds';
    if (!Array.isArray(doc.root[key])) doc.root[key] = [];
    (doc.root[key] as AnyObj[]).push(node);
    return tag;
  }

  exportJson(): string {
    return JSON.stringify({ version: 2, nodes: this.nodes(), rules: this.rules() }, null, 2);
  }

  /** 导入 JSON（与导出的格式一致；同来源同 tag 覆盖） */
  importJson(text: string): { ok: boolean; added: number; error?: string } {
    try {
      const st = JSON.parse(text) as Partial<PoolState>;
      const incoming = Array.isArray(st?.nodes) ? (st!.nodes as PoolNode[]) : [];
      const valid = incoming.filter(
        (n) => n && typeof n.tag === 'string' && n.node && typeof n.node === 'object' && typeof n.sourceApi === 'string',
      );
      const incomingRulesRaw = Array.isArray((st as PoolState)?.rules) ? (st as PoolState).rules : [];
      const incomingRules = incomingRulesRaw.filter(
        (r) => r && typeof r.group === 'string' && Array.isArray(r.refs),
      );
      // 允许只带 rules（或只带 nodes）导入
      if (!valid.length && !incomingRules.length) {
        return { ok: false, added: 0, error: '没有可导入的节点或规则池条目（结构不符）' };
      }
      const list = [...this.nodes()];
      let added = 0;
      for (const n of valid) {
        const entry: PoolNode = {
          id: n.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          sourceApi: n.sourceApi,
          sourceName: n.sourceName || n.sourceApi,
          tag: n.tag,
          kind: n.kind === 'endpoint' ? 'endpoint' : 'outbound',
          node: structuredClone(n.node),
          addedAt: n.addedAt || Date.now(),
        };
        const i = list.findIndex((x) => x.sourceApi === entry.sourceApi && x.tag === entry.tag);
        if (i >= 0) list[i] = entry;
        else {
          list.unshift(entry);
          added += 1;
        }
      }
      const rl = [...this.rules()];
      for (const r of incomingRules) {
        if (!r || typeof r.group !== 'string' || !Array.isArray(r.refs)) continue;
        const entry: PoolRules = {
          id: r.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          group: r.group,
          refs: [...new Set(r.refs.map((x) => String(x)))],
          applied: r.applied === true,
          appliedAt: r.appliedAt,
          originName: r.originName,
          addedAt: r.addedAt || Date.now(),
        };
        const i = rl.findIndex((x) => x.group === entry.group);
        if (i >= 0) rl[i] = entry;
        else {
          rl.unshift(entry);
          added += 1;
        }
      }
      this.save({ nodes: list, rules: rl });
      return { ok: true, added };
    } catch (e) {
      return { ok: false, added: 0, error: (e as Error)?.message ?? 'JSON 解析失败' };
    }
  }
}

/**
 * 把池里的节点**覆盖**到文档里的同名节点上（同名才允许）：
 *   · 目标必须存在同名 outbound / endpoint，且与池条目同类型（出站↔出站、endpoint↔endpoint）；
 *   · 用池里的配置整体替换（tag 沿用目标的同名 tag，位置不变）；
 *   · 不同名一律拒绝 —— 不会新增节点、不会改 tag、不动分组/规则引用。
 */
export function replaceSameNameNode(
  doc: ConfigDoc,
  poolNode: { tag: string; node: AnyObj; kind: PoolKind },
  targetTag: string,
): { ok: boolean; reason?: string; kind?: PoolKind } {
  if (poolNode.tag !== targetTag) {
    return { ok: false, reason: `只有同名节点可以覆盖：拖的是「${poolNode.tag}」，目标是「${targetTag}」` };
  }
  const groupsWhere = (key: 'outbounds' | 'endpoints'): AnyObj[] =>
    Array.isArray(doc.root[key]) ? (doc.root[key] as AnyObj[]) : [];
  const findIn = (key: 'outbounds' | 'endpoints'): { list: AnyObj[]; idx: number } | null => {
    const list = groupsWhere(key);
    const idx = list.findIndex((o) => String(o['tag'] ?? '') === targetTag);
    return idx >= 0 ? { list, idx } : null;
  };
  const inOb = findIn('outbounds');
  const inEp = findIn('endpoints');
  const hit = inOb ?? inEp;
  if (!hit) return { ok: false, reason: `目标路由上没有叫「${targetTag}」的节点` };
  const targetKind: PoolKind = inEp && !inOb ? 'endpoint' : 'outbound';
  if (targetKind !== poolNode.kind) {
    return {
      ok: false,
      reason: `类型不同不能覆盖：池里这条是 ${poolNode.kind === 'endpoint' ? 'endpoints' : '普通出站'}，路由上的是 ${targetKind === 'endpoint' ? 'endpoints' : '普通出站'}`,
    };
  }
  hit.list[hit.idx] = { ...structuredClone(poolNode.node), tag: targetTag };
  return { ok: true, kind: targetKind };
}

/** 一台路由上某个组名的状态 */
export interface GroupStatusPerRouter {
  tag: string;
  name: string;
  /** 读配置失败的原因（非空 = 这台路由的情况未知） */
  err?: string;
  /** 这台路由有没有同名出口（组/节点/内置 direct…） */
  hasOutbound: boolean;
  /** 这台路由该组名的规则集引用（并集） */
  refs: string[];
  /** 目标缺的 / 目标多的 */
  missing: string[];
  extra: string[];
  /** 是否已经「采用同一套规则集」 */
  same: boolean;
}

/** 同一套规则集 = 集合相等（顺序不影响语义） */
export function sameRefSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/** 某台路由上「组名 → 规则集并集」（直接收一份 doc，便于测试） */
export function routerGroupRefs(doc: ConfigDoc | null, group: string): { hasOutbound: boolean; refs: string[] } {
  if (!doc) return { hasOutbound: false, refs: [] };
  const tags = new Set([...outbounds(doc), ...endpoints(doc)].map((o) => String(o['tag'] ?? '')));
  tags.add('direct');
  tags.add('block');
  tags.add('dns');
  const refs: string[] = [];
  for (const r of routeRules(doc)) {
    if (String(r['outbound'] ?? '') !== group) continue;
    const v = r['rule_set'];
    const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : [];
    for (const x of list) if (!refs.includes(x)) refs.push(x);
  }
  return { hasOutbound: tags.has(group), refs };
}

/**
 * 判断某条共享规则在各路由器上的采用情况 —— 规则池「已应用 / 未应用」的判定依据：
 *   · 只算**有同名出口**的路由（没有同名出口说明它根本不用这一组，不算未应用）；
 *   · 每台这类路由，该组名的规则集并集必须与池里的 refs 完全一致；
 *   · 有一台读不到配置 → 结论未知（err 非空）。
 */
export function groupStatus(
  poolRefs: string[],
  group: string,
  routers: { tag: string; name: string; doc: ConfigDoc | null; err?: string }[],
): GroupStatusPerRouter[] {
  return routers.map((r) => {
    if (r.err || !r.doc) {
      return {
        tag: r.tag,
        name: r.name,
        err: r.err || '读不到配置',
        hasOutbound: true,
        refs: [],
        missing: poolRefs,
        extra: [],
        same: false,
      };
    }
    const { hasOutbound, refs } = routerGroupRefs(r.doc, group);
    const missing = poolRefs.filter((x) => !refs.includes(x));
    const extra = refs.filter((x) => !poolRefs.includes(x));
    return {
      tag: r.tag,
      name: r.name,
      hasOutbound,
      refs,
      missing,
      extra,
      same: hasOutbound && missing.length === 0 && extra.length === 0,
    };
  });
}

/** 一条规则在某台路由上的归属（启动核对用） */
export type RouterFit = 'same' | 'drift' | 'na' | 'unknown';

/**
 * 启动核对：这条规则在哪几台「读到了配置、有同名出口、却与共享规则不一致」
 * （池里标了已应用、路由实际没跟上）。
 * **读不到配置的不算漂移**（那是 unknown，要单独提示「没核对到」），否则网络抖动会被误报成规则不一致。
 */
export function driftedRouters(status: GroupStatusPerRouter[]): GroupStatusPerRouter[] {
  return status.filter((s) => !s.err && s.hasOutbound && !s.same);
}

/** 没核对到的路由（读配置失败）：既不能算一致，也不能算漂移 */
export function unknownRouters(status: GroupStatusPerRouter[]): GroupStatusPerRouter[] {
  return status.filter((s) => !!s.err);
}

/** 汇总：全部有同名出口的路由都一致 → 已应用 */
export function isAppliedEverywhere(status: GroupStatusPerRouter[]): boolean {
  const used = status.filter((s) => s.hasOutbound || !!s.err);
  if (!used.length) return false;
  return used.every((s) => s.same);
}
