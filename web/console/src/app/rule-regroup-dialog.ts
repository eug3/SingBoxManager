import { ChangeDetectionStrategy, Component, OnInit, computed, input, output, signal } from '@angular/core';
import {
  AnyObj,
  CondRuleRow,
  ConfigDoc,
  RegroupRowPlan,
  applyRegroupRows,
  condIsEmpty,
  condRuleRows,
  groups,
  mergeCondData,
  nodes,
  pruneOrphanGroups,
  ruleSetGroups,
  tidyCond,
} from './config-ops';

/** 弹窗里的一行：桶引用组 或 纯条件规则 */
interface Row {
  id: number;
  index: number | null;
  /** 新增行插在哪个原下标之后（-1 = 末尾） */
  anchor: number;
  outbound: string;
  kind: 'bucket' | 'cond';
  /** kind=bucket：引用的桶 tag */
  buckets: string[];
  /** kind=cond：条件字段（不含 outbound / rule_set） */
  cond: AnyObj | null;
  /** cond 行的合并签名（字段集合）；只有相同签名才能合并 */
  sig: string;
  /** cond 行能否参与合并（恰好一个数组字段、没有标量） */
  mergeable: boolean;
}

let seq = 0;

/**
 * 「拆解与合并」弹窗 — 只针对右键那条规则所属的**一个出口分组**：
 *   · 桶引用组：一条规则引用多个 rule_set，可以把桶拖到别的组（拆解 / 合并）；
 *   · 纯条件规则（port / ip_cidr …）：同出口 + 同条件字段的行可以拖到一起合成一条（数组取并集）。
 *
 * 保存口径：有内容原地替换（保留该规则其它字段与位置）；新增行插在 anchor 之后；
 * 空行 → 对应规则删除（「空的组自动消失」）；新建但没内容的行不落盘；
 * 只清理**本出口**在本次改动后变孤儿的出站（至少保留 1 个分组）。
 */
@Component({
  selector: 'app-rule-regroup-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-regroup-dialog.html',
})
export class RuleRegroupDialog implements OnInit {
  readonly doc = input<ConfigDoc | null>(null);
  /** 右键那条规则所属的出口：弹窗只列这个出口下的规则 */
  readonly outbound = input<string>('');
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  readonly rows = signal<Row[]>([]);
  readonly err = signal('');
  readonly note = signal('');
  /** 正在拖的桶 / 条件值 */
  readonly drag = signal<{ kind: 'bucket' | 'cond'; tag?: string; rowId: number } | null>(null);
  /** 正在整行拖的条件行 */
  readonly dragRow = signal<number | null>(null);
  /** 当前悬停的落点行 */
  readonly over = signal<number | null>(null);

  ngOnInit(): void {
    this.ensureRows();
  }

  private inited = false;
  private ensureRows(): void {
    if (this.inited) return;
    this.inited = true;
    const d = this.doc();
    if (!d) return;
    const ob = this.outbound() || undefined;
    const buckets: Row[] = ruleSetGroups(d, ob).map((g) => ({
      id: ++seq,
      index: g.index,
      anchor: g.index ?? -1,
      outbound: g.outbound,
      kind: 'bucket',
      buckets: [...g.tags],
      cond: null,
      sig: '',
      mergeable: false,
    }));
    const conds: Row[] = condRuleRows(d, ob).map((c: CondRuleRow) => ({
      id: ++seq,
      index: c.index,
      anchor: c.index,
      outbound: c.outbound,
      kind: 'cond',
      buckets: [],
      // 数组条件 + 标量条件都要带上（标量原样保留，否则保存会把这些字段弄丢）
      cond: {
        ...Object.fromEntries(c.arrays.map((a) => [a.field, [...a.values]])),
        ...Object.fromEntries(c.scalars.map((s) => [s.field, s.value])),
      },
      sig: c.sig,
      mergeable: c.mergeable,
    }));
    // 按原顺序排（规则表里谁在前谁在前）
    const all = [...buckets, ...conds].sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9));
    this.rows.set(all);
  }

  readonly outboundOptions = computed(() => {
    const d = this.doc();
    if (!d) return [];
    const gs = groups(d).map((g) => ({ tag: String(g['tag']), label: `${String(g['tag'])}（分组）` }));
    const sp = nodes(d)
      .filter((n) => n.special)
      .map((n) => ({ tag: n.tag, label: `${n.tag}（${n.type}）` }));
    return [...gs, ...sp];
  });

  /** 空行数：保存后会消失（对应规则被删） */
  readonly emptyCount = computed(() => this.rows().filter((r) => this.isEmpty(r)).length);

  isEmpty(r: Row): boolean {
    return r.kind === 'bucket' ? r.buckets.length === 0 : condIsEmpty(r.cond);
  }

  /** cond 行的显示文案：字段名 + 值 */
  condChips(r: Row): { field: string; value: string }[] {
    if (r.kind !== 'cond' || !r.cond) return [];
    const out: { field: string; value: string }[] = [];
    for (const [field, v] of Object.entries(r.cond)) {
      for (const x of Array.isArray(v) ? v : [v]) out.push({ field, value: String(x) });
    }
    return out;
  }

  /** 保存时会被清掉的分组出站预演 */
  readonly prunePreview = computed<string[]>(() => {
    const d = this.doc();
    if (!d) return [];
    try {
      const clone: ConfigDoc = structuredClone(d);
      this.applyPlan(clone);
      return pruneOrphanGroups(clone, [this.outbound() || '']);
    } catch {
      return [];
    }
  });

  /* ── 拖动 ── */

  onChipDragStart(row: Row, ev: DragEvent, tag?: string): void {
    this.drag.set({ kind: row.kind, tag, rowId: row.id });
    ev.dataTransfer?.setData('text/plain', tag ?? row.id.toString());
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  onRowDragStart(row: Row, ev: DragEvent): void {
    this.dragRow.set(row.id);
    this.drag.set({ kind: 'cond', rowId: row.id });
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(row: Row, ev: DragEvent): void {
    if (!this.drag() && this.dragRow() === null) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    if (this.over() !== row.id) this.over.set(row.id);
  }

  onDragLeave(row: Row, ev: DragEvent): void {
    const el = ev.currentTarget as HTMLElement | null;
    const to = ev.relatedTarget as Node | null;
    if (el && to && el.contains(to)) return;
    if (this.over() === row.id) this.over.set(null);
  }

  onDrop(target: Row, ev: DragEvent): void {
    ev.preventDefault();
    const d = this.drag();
    const rowId = this.dragRow();
    this.drag.set(null);
    this.dragRow.set(null);
    this.over.set(null);
    if (rowId !== null) {
      this.mergeRows(rowId, target.id);
      return;
    }
    if (!d) return;
    if (d.kind === 'bucket' && d.tag) this.moveBucket(d.tag, d.rowId, target.id);
    if (d.kind === 'cond' && d.tag) this.moveCondValue(d.tag, d.rowId, target.id);
  }

  private moveBucket(tag: string, fromId: number, toId: number): void {
    if (fromId === toId) return;
    this.rows.update((list) => {
      const src = list.find((r) => r.id === fromId);
      const dst = list.find((r) => r.id === toId);
      if (!src || !dst || dst.kind !== 'bucket') return list;
      src.buckets = src.buckets.filter((t) => t !== tag);
      if (!dst.buckets.includes(tag)) dst.buckets = [...dst.buckets, tag];
      return [...list];
    });
  }

  /** 条件值拖动：`field:value` 形式；目标行字段集合必须相同 */
  private moveCondValue(carried: string, fromId: number, toId: number): void {
    const [field, ...rest] = carried.split('::');
    const value = rest.join('::');
    const src = this.rows().find((r) => r.id === fromId);
    const dst = this.rows().find((r) => r.id === toId);
    if (!src || !dst || src === dst) return;
    if (dst.kind !== 'cond' || !src.cond || !dst.cond) {
      this.note.set('条件值只能拖到另一条条件规则上');
      return;
    }
    if (src.sig !== dst.sig) {
      this.note.set(`条件字段不同（${src.sig || '空'} vs ${dst.sig || '空'}），不能合并`);
      return;
    }
    this.rows.update((list) => {
      const s = list.find((r) => r.id === fromId)!;
      const t = list.find((r) => r.id === toId)!;
      const sv = Array.isArray(s.cond![field]) ? (s.cond![field] as unknown[]).filter((x) => String(x) !== value) : [];
      const tv = Array.isArray(t.cond![field]) ? (t.cond![field] as unknown[]) : [];
      s.cond![field] = sv;
      t.cond![field] = [...tv, value];
      // 拖空了的字段直接从 cond 里摘掉，避免留下 {"port": []}
      s.cond = tidyCond(s.cond);
      t.cond = tidyCond(t.cond);
      return [...list];
    });
    this.note.set('');
  }

  /** 整行合并：字段集合相同 → 数组取并集 */
  private mergeRows(fromId: number, toId: number): void {
    if (fromId === toId) return;
    const src = this.rows().find((r) => r.id === fromId);
    const dst = this.rows().find((r) => r.id === toId);
    if (!src || !dst) return;
    if (dst.kind !== 'cond' || !src.cond || !dst.cond) {
      this.note.set('整行合并只支持条件规则；桶请拖 chip');
      return;
    }
    const res = mergeCondData(dst.cond, src.cond);
    if (!res.ok) {
      this.note.set(res.reason);
      return;
    }
    this.rows.update((list) => {
      const t = list.find((r) => r.id === toId)!;
      t.cond = res.merged;
      const s = list.find((r) => r.id === fromId)!;
      s.cond = {}; // 整行被并走 → 空行，保存时删掉这条规则
      return [...list];
    });
    this.note.set('已合并（保存后生效）');
  }

  /* ── 行操作 ── */

  addRow(anchorRow: Row | null): void {
    const fallback = this.outboundOptions()[0]?.tag ?? 'DIRECT';
    const row: Row = {
      id: ++seq,
      index: null,
      anchor: anchorRow?.index ?? -1,
      outbound: anchorRow?.outbound || fallback,
      kind: 'bucket',
      buckets: [],
      cond: null,
      sig: '',
      mergeable: false,
    };
    this.rows.update((list) => {
      if (!anchorRow) return [...list, row];
      const i = list.findIndex((r) => r.id === anchorRow.id);
      const next = [...list];
      next.splice(i + 1, 0, row);
      return next;
    });
  }

  removeRow(row: Row): void {
    this.rows.update((list) => list.filter((r) => r.id !== row.id));
  }

  setOutbound(row: Row, tag: string): void {
    this.rows.update((list) => list.map((r) => (r.id === row.id ? { ...r, outbound: tag } : r)));
  }

  /* ── 保存 ── */

  private applyPlan(doc: ConfigDoc): void {
    const plan: RegroupRowPlan[] = this.rows().map((r) => ({
      index: r.index,
      anchor: r.anchor,
      outbound: r.outbound,
      buckets: r.kind === 'bucket' ? [...r.buckets] : [],
      cond: r.kind === 'cond' ? (r.cond ? { ...r.cond } : null) : null,
    }));
    applyRegroupRows(doc, plan);
  }

  save(): void {
    const d = this.doc();
    if (!d) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const doc: ConfigDoc = structuredClone(d);
    try {
      this.applyPlan(doc);
      pruneOrphanGroups(doc, [this.outbound() || '']);
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
      return;
    }
    this.err.set('');
    this.docChange.emit(doc);
    this.closed.emit();
  }

  close(): void {
    this.closed.emit();
  }

  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}
