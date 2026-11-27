import { Injectable, signal } from '@angular/core';
import { AnyObj, ConfigDoc, outbounds } from './config-ops';

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
  /** 完整出站对象（保留 server/密钥/tls/transport 等全部字段） */
  node: AnyObj;
  /** 加入时间（ms） */
  addedAt: number;
}

interface PoolState {
  version: 1;
  nodes: PoolNode[];
}

const KEY = 'sbm.sharedPool.v1';

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
  readonly nodes = signal<PoolNode[]>(this.load());

  private load(): PoolNode[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const st = JSON.parse(raw) as PoolState;
      if (!st || st.version !== 1 || !Array.isArray(st.nodes)) return [];
      return st.nodes.filter((n) => n && typeof n.tag === 'string' && n.node && typeof n.node === 'object');
    } catch {
      return [];
    }
  }

  private save(list: PoolNode[]): void {
    this.nodes.set(list);
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, nodes: list } satisfies PoolState));
    } catch {
      /* 隐私模式写不进去：内存里仍有，本会话可用 */
    }
  }

  /** 加入池子：同一来源 + 同 tag 视为同一条（覆盖旧内容）；返回是否新加入 */
  addNode(source: { api: string; name: string }, node: AnyObj): { ok: boolean; dup: boolean; reason?: string } {
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
      node: structuredClone(node),
      addedAt: Date.now(),
    };
    this.save(same ? list.map((n) => (n.id === same.id ? entry : n)) : [entry, ...list]);
    return { ok: true, dup: !!same };
  }

  removeNode(id: string): void {
    this.save(this.nodes().filter((n) => n.id !== id));
  }

  clear(): void {
    this.save([]);
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
    const used = new Set(doc ? outbounds(doc).map((o) => String(o['tag'] ?? '')) : []);
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

  /** 把池里的节点导入文档（保留原对象全部字段；tag 冲突自动改名）。返回最终 tag */
  importInto(doc: ConfigDoc, item: PoolNode): string {
    const tag = this.uniqueTagFor(doc, item.tag, item.sourceName);
    const node: AnyObj = { ...structuredClone(item.node), tag };
    const list = doc.root['outbounds'];
    if (!Array.isArray(list)) doc.root['outbounds'] = [];
    (doc.root['outbounds'] as AnyObj[]).push(node);
    return tag;
  }

  exportJson(): string {
    return JSON.stringify({ version: 1, nodes: this.nodes() }, null, 2);
  }

  /** 导入 JSON（与导出的格式一致；同来源同 tag 覆盖） */
  importJson(text: string): { ok: boolean; added: number; error?: string } {
    try {
      const st = JSON.parse(text) as Partial<PoolState>;
      const incoming = Array.isArray(st?.nodes) ? (st!.nodes as PoolNode[]) : [];
      const valid = incoming.filter(
        (n) => n && typeof n.tag === 'string' && n.node && typeof n.node === 'object' && typeof n.sourceApi === 'string',
      );
      if (!valid.length) return { ok: false, added: 0, error: '没有可导入的节点（结构不符）' };
      const list = [...this.nodes()];
      let added = 0;
      for (const n of valid) {
        const entry: PoolNode = {
          id: n.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          sourceApi: n.sourceApi,
          sourceName: n.sourceName || n.sourceApi,
          tag: n.tag,
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
      this.save(list);
      return { ok: true, added };
    } catch (e) {
      return { ok: false, added: 0, error: (e as Error)?.message ?? 'JSON 解析失败' };
    }
  }
}
