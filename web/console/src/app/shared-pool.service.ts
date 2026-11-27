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

/** 共享规则池的一条：某个「组名（出站 tag）」下挂的整套 rule_set 引用 */
export interface PoolRules {
  id: string;
  sourceApi: string;
  sourceName: string;
  /** 组名 / 出站 tag（如 🚀 节点选择）；目标路由只要有同名 outbound 的规则即可套用 */
  group: string;
  /** 这套组名用到的 rule_set 引用（顺序保留；去重后的并集） */
  refs: string[];
  addedAt: number;
}

interface PoolState {
  version: 2;
  nodes: PoolNode[];
  rules: PoolRules[];
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
        ? st.rules.filter(
            (r) => r && typeof r.group === 'string' && Array.isArray(r.refs) && typeof r.sourceApi === 'string',
          )
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

  removeNode(id: string): void {
    this.save({ nodes: this.nodes().filter((n) => n.id !== id) });
  }

  clear(): void {
    this.save({ nodes: [], rules: [] });
  }

  /* ── 共享规则池：组名 → 整套 rule_set 引用 ── */

  /** 把「组名 + 它挂的全部规则集」加入规则池（同来源同组名 = 更新） */
  addRuleGroup(
    source: { api: string; name: string },
    group: string,
    refs: string[],
  ): { ok: boolean; dup: boolean; reason?: string } {
    const g = String(group ?? '').trim();
    if (!g) return { ok: false, dup: false, reason: '没有组名，无法共享' };
    if (!refs.length) return { ok: false, dup: false, reason: '这个组名没有挂规则集，没什么可共享的' };
    const list = this.rules();
    const same = list.find((r) => r.sourceApi === source.api && r.group === g);
    const entry: PoolRules = {
      id: same?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sourceApi: source.api,
      sourceName: source.name || source.api,
      group: g,
      refs: [...new Set(refs)],
      addedAt: Date.now(),
    };
    this.save({ rules: same ? list.map((r) => (r.id === same.id ? entry : r)) : [entry, ...list] });
    return { ok: true, dup: !!same };
  }

  removeRule(id: string): void {
    this.save({ rules: this.rules().filter((r) => r.id !== id) });
  }

  /** 规则池按来源分组 */
  rulesBySource(): { sourceName: string; sourceApi: string; items: PoolRules[] }[] {
    const map = new Map<string, { sourceName: string; sourceApi: string; items: PoolRules[] }>();
    for (const r of this.rules()) {
      const g = map.get(r.sourceApi) ?? { sourceName: r.sourceName, sourceApi: r.sourceApi, items: [] };
      g.items.push(r);
      map.set(r.sourceApi, g);
    }
    return [...map.values()];
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
          sourceApi: r.sourceApi || 'imported',
          sourceName: r.sourceName || r.sourceApi || 'imported',
          group: r.group,
          refs: [...new Set(r.refs.map((x) => String(x)))],
          addedAt: r.addedAt || Date.now(),
        };
        const i = rl.findIndex((x) => x.sourceApi === entry.sourceApi && x.group === entry.group);
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
