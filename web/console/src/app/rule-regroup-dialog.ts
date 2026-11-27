import { ChangeDetectionStrategy, Component, OnInit, computed, input, output, signal } from '@angular/core';
import {
  ConfigDoc,
  RuleGroupPlan,
  RuleSetGroup,
  applyRuleGroups,
  groups,
  nodes,
  pruneOrphanGroups,
  ruleSetGroups,
} from './config-ops';

/** 弹窗里的行：在 RuleSetGroup 之上加一个稳定的 id（拖拽用） */
interface Row extends RuleSetGroup {
  id: number;
  /** 新增组：插在这条原规则之后（改动前下标；-1 = 末尾） */
  anchor: number;
}

let seq = 0;

/**
 * 「拆解与合并」弹窗 — 把 route.rules 里**引用 rule_set 的那几条**摊开成组，
 * 拖桶在组之间搬：一组拆成两组（拆解）、两个桶并进一组（合并）。
 *
 * 保存口径：
 *  · 有桶的组 → 原地替换 rule_set（保留该规则其它条件与位置）；新增组插在创建它的那条规则之后；
 *  · 没桶的组 → 那条规则被删掉（空的组自动消失）；新建但没放桶的组不写盘；
 *  · 顺带清理「没有任何规则/成员/final 指向」的分组出站，但至少保留 1 个分组。
 */
@Component({
  selector: 'app-rule-regroup-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-regroup-dialog.html',
})
export class RuleRegroupDialog implements OnInit {
  readonly doc = input<ConfigDoc | null>(null);
  /** 右键那条规则所属的出口：弹窗只列这个出口下的规则（不把全部组摊开） */
  readonly outbound = input<string>('');
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  readonly rows = signal<Row[]>([]);
  readonly err = signal('');
  /** 正在拖的桶（含来源行 id） */
  readonly drag = signal<{ tag: string; from: number } | null>(null);
  /** 当前悬停的落点行 */
  readonly over = signal<number | null>(null);

  ngOnInit(): void {
    this.ensureRows();
  }

  /** 首次渲染前把行建好（input 在构造时可用） */
  private inited = false;
  private ensureRows(): void {
    if (this.inited) return;
    this.inited = true;
    const d = this.doc();
    const list = d ? ruleSetGroups(d, this.outbound() || undefined) : [];
    this.rows.set(
      list.map((g) => ({ ...g, id: ++seq, anchor: g.index ?? -1 })),
    );
  }

  /** 可选出站：分组在前、特殊出站垫底 */
  readonly outboundOptions = computed(() => {
    const d = this.doc();
    if (!d) return [];
    const gs = groups(d).map((g) => ({ tag: String(g['tag']), label: `${String(g['tag'])}（分组）` }));
    const sp = nodes(d)
      .filter((n) => n.special)
      .map((n) => ({ tag: n.tag, label: `${n.tag}（${n.type}）` }));
    return [...gs, ...sp];
  });

  /** 空组提示：保存后会消失（对应规则被删） */
  readonly emptyCount = computed(() => this.rows().filter((r) => !r.tags.length).length);

  /** 保存时会被清掉的分组出站预演（没人指向的组；至少保留 1 个） */
  readonly prunePreview = computed<string[]>(() => {
    const d = this.doc();
    if (!d) return [];
    try {
      const clone: ConfigDoc = structuredClone(d);
      const plan: RuleGroupPlan[] = this.rows().map((r) => ({
        index: r.index,
        anchor: r.anchor,
        outbound: r.outbound,
        tags: [...r.tags],
      }));
      applyRuleGroups(clone, plan);
      return pruneOrphanGroups(clone, [this.outbound() || '']);
    } catch {
      return [];
    }
  });

  private move(tag: string, fromId: number, toId: number): void {
    if (fromId === toId) return;
    this.rows.update((list) => {
      const src = list.find((r) => r.id === fromId);
      const dst = list.find((r) => r.id === toId);
      if (!src || !dst) return list;
      src.tags = src.tags.filter((t) => t !== tag);
      if (!dst.tags.includes(tag)) dst.tags = [...dst.tags, tag];
      return [...list];
    });
  }

  onDragStart(row: Row, tag: string, ev: DragEvent): void {
    this.drag.set({ tag, from: row.id });
    ev.dataTransfer?.setData('text/plain', tag);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(row: Row, ev: DragEvent): void {
    if (!this.drag()) return;
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

  onDrop(row: Row, ev: DragEvent): void {
    ev.preventDefault();
    const d = this.drag();
    this.drag.set(null);
    this.over.set(null);
    if (!d) return;
    this.move(d.tag, d.from, row.id);
  }

  /** 新增一个空组（插在 anchorRow 之后；anchorRow=null → 末尾） */
  addRow(anchorRow: Row | null): void {
    const d = this.doc();
    const fallback = this.outboundOptions()[0]?.tag ?? 'DIRECT';
    const outbound = anchorRow?.outbound || fallback;
    const anchor = anchorRow?.index ?? -1;
    const row: Row = { id: ++seq, index: null, anchor, outbound, tags: [] };
    this.rows.update((list) => {
      if (!anchorRow) return [...list, row];
      const i = list.findIndex((r) => r.id === anchorRow.id);
      const next = [...list];
      next.splice(i + 1, 0, row);
      return next;
    });
  }

  /** 删掉这一行（其中的桶一并丢弃 = 对应规则被删） */
  removeRow(row: Row): void {
    this.rows.update((list) => list.filter((r) => r.id !== row.id));
  }

  setOutbound(row: Row, tag: string): void {
    this.rows.update((list) => list.map((r) => (r.id === row.id ? { ...r, outbound: tag } : r)));
  }

  save(): void {
    const d = this.doc();
    if (!d) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const doc: ConfigDoc = structuredClone(d);
    try {
      const plan: RuleGroupPlan[] = this.rows().map((r) => ({
        index: r.index,
        anchor: r.anchor,
        outbound: r.outbound,
        tags: [...r.tags],
      }));
      applyRuleGroups(doc, plan);
      // 只清理「本出口」在本次改动后变成孤儿的出站：右键拆解只针对一个出口分组，
      // 不能顺手把别的空组删掉
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
