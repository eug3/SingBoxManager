import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ConfigDoc, moveRule } from './config-ops';
import { RuleRegroupDialog } from './rule-regroup-dialog';
import { RouteRuleInfo, countRuleHits, readRuleModel } from './rule-model';
import { LiveStatService } from './live-stat.service';
import { Backend } from './models';

/** 拖动落点：插到 index 这一行之前 / 之后 */
interface DropPoint {
  index: number;
  after: boolean;
}

/**
 * 规则顺序表 — config `route.rules` 的**生效顺序**（自上而下第一条命中即停），
 * 支持拖动行 + ↑↓ 调序，并显示每条规则的出口与当前命中数。
 *
 * 为什么不用 GET /rules：那是运行时只读镜像，改不了；这张表读 config（草稿优先），
 * 拖动后产出新 `ConfigDoc` → 调用方 stage 到 ConfigDraftService（顶部待保存条）→
 * 「保存并重启」后才写回路由；重启后再去折叠区「核对运行态」逐行对照即可。
 *
 * 交互约束：
 *  · 头部连续的动作规则（sniff / hijack-dns / resolve）钉住：不可拖、也不允许别的行挪到它们前面；
 *  · 行内 ↑↓ 与拖动等价；动作规则行没有把手。
 *  · 命中列来自共享连接快照（LiveStatService），只对「纯 rule_set 规则」与 final 精确统计，
 *    其它规则显示 —（不猜测归并，免得把命中算到错的行上）。
 */
@Component({
  selector: 'app-rule-order',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RuleRegroupDialog],
  templateUrl: './rule-order.html',
})
export class RuleOrder {
  readonly doc = input<ConfigDoc | null>(null);
  readonly backend = input.required<Backend>();
  readonly docChange = output<ConfigDoc>();

  private readonly live = inject(LiveStatService);

  /** 当前表格行（config 顺序） */
  readonly rows = computed<RouteRuleInfo[]>(() => {
    const d = this.doc();
    return d ? readRuleModel(d).routeRules : [];
  });

  /** 头部连续动作规则的条数：这些行钉在最前，不允许被跨过 */
  readonly minMovable = computed(() => {
    let n = 0;
    for (const r of this.rows()) {
      if (r.actionOnly) n++;
      else break;
    }
    return n;
  });

  /** 命中统计（按后端过滤共享快照，切后端不会串数据） */
  private readonly hitStats = computed(() => {
    const snap = this.live.snap();
    const conns = snap && snap.api === this.backend().api ? snap.conns : [];
    return countRuleHits(this.rows(), conns);
  });

  /** 单条规则的命中数 */
  hitOf(index: number): number {
    return this.hitStats().hits.get(index) ?? 0;
  }

  /** route.final 的命中数（不在这张表里，单独显示） */
  readonly finalHits = computed(() => this.hitStats().final);
  /** 命中总数 */
  readonly totalHits = computed(() => {
    let n = 0;
    for (const v of this.hitStats().hits.values()) n += v;
    return n;
  });
  /** 0 命中的规则条数（排除动作规则，它们本来就不选路） */
  readonly idleRows = computed(
    () => this.rows().filter((r) => !r.actionOnly && this.hitOf(r.index) === 0).length,
  );
  /** 连接里有、但对不上任何配置规则串的条数（多条件 / 逻辑规则） */
  readonly unmatched = computed(() => this.hitStats().unmatched);

  /* ── 右键菜单「拆解与合并」 ── */
  /** 右键菜单（屏幕坐标 + 命中的规则行） */
  readonly menu = signal<{ x: number; y: number; index: number } | null>(null);
  /** 拆解与合并弹窗是否打开 */
  readonly regroupOpen = signal(false);
  /** 右键那条规则的出口（弹窗只针对这一个出口分组） */
  readonly regroupOutbound = signal('');

  /** 右键某行：弹出菜单（没有 rule_set 引用的行也能弹，只是项禁用） */
  onRowContext(r: RouteRuleInfo, ev: MouseEvent): void {
    ev.preventDefault();
    this.menu.set({ x: ev.clientX, y: ev.clientY, index: r.index });
  }

  closeMenu(): void {
    this.menu.set(null);
  }

  /** 菜单项「拆解与合并…」：按右键那条规则的出口收敛弹窗内容 */
  openRegroup(): void {
    const m = this.menu();
    const row = m ? this.rows().find((r) => r.index === m.index) : undefined;
    this.regroupOutbound.set(row?.outbound ?? '');
    this.menu.set(null);
    this.regroupOpen.set(true);
  }

  /** 弹窗保存：产出新文档 → 交给宿主暂存（与 ↑↓ 调序同一条链路） */
  onRegroup(doc: ConfigDoc): void {
    this.regroupOpen.set(false);
    this.docChange.emit(doc);
  }

  /** 当前右键行的桶数（0 = 不能拆解） */
  readonly menuRefs = computed(() => {
    const m = this.menu();
    if (!m) return 0;
    return this.rows().find((r) => r.index === m.index)?.ruleSetRefs.length ?? 0;
  });

  /* ── 拖动状态 ── */
  /** 正在拖的行下标（null = 没在拖） */
  readonly dragFrom = signal<number | null>(null);
  /** 当前落点（行 + 前后半区） */
  readonly dropAt = signal<DropPoint | null>(null);

  /** 能上移：不在钉住的头部动作区，且上面还有可动位置 */
  canUp(index: number): boolean {
    return index > this.minMovable();
  }

  /** 能下移：不是最后一条 */
  canDown(index: number): boolean {
    return index < this.rows().length - 1;
  }

  onDragStart(r: RouteRuleInfo, ev: DragEvent): void {
    if (r.actionOnly) {
      ev.preventDefault();
      return;
    }
    this.dragFrom.set(r.index);
    const dt = ev.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'move';
    try {
      dt.setData('text/plain', String(r.index));
    } catch {
      /* 隐私模式下可能被拒，靠 dragFrom 也能工作 */
    }
  }

  onDragOver(index: number, ev: DragEvent): void {
    if (this.dragFrom() === null) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const el = ev.currentTarget as HTMLElement | null;
    const rect = el?.getBoundingClientRect();
    const after = rect ? ev.clientY - rect.top > rect.height / 2 : false;
    const cur = this.dropAt();
    if (!cur || cur.index !== index || cur.after !== after) this.dropAt.set({ index, after });
  }

  onDragLeave(index: number, ev: DragEvent): void {
    const el = ev.currentTarget as HTMLElement | null;
    const to = ev.relatedTarget as Node | null;
    if (el && to && el.contains(to)) return; // 行内移动不算离开
    if (this.dropAt()?.index === index) this.dropAt.set(null);
  }

  onDrop(index: number, ev: DragEvent): void {
    ev.preventDefault();
    const from = this.dragFrom();
    const point = this.dropAt() ?? { index, after: false };
    this.resetDrag();
    if (from === null) return;
    this.applyMove(from, point);
  }

  onDragEnd(): void {
    this.resetDrag();
  }

  /** ↑↓ 按钮：下移 = 插到下一行之后（否则「插到下一行之前」会原地不动） */
  move(index: number, dir: -1 | 1): void {
    const to = index + dir;
    if (to < this.minMovable() || to >= this.rows().length) return;
    this.applyMove(index, { index: to, after: dir > 0 });
  }

  /** 统一落点计算：from → (目标行 + 前后半区) → 实际插入下标 → 产出新文档 */
  private applyMove(from: number, point: DropPoint): void {
    const base = this.doc();
    if (!base) return;
    if (this.rows()[from]?.actionOnly) return;
    // 掉到某行后半区 = 插到它之后
    let to = point.after ? point.index + 1 : point.index;
    if (from < to) to -= 1; // 先摘掉自己再插，下标要回退一格
    const max = this.rows().length - 1;
    to = Math.max(this.minMovable(), Math.min(to, max));
    if (to === from) return;
    const doc: ConfigDoc = structuredClone(base);
    try {
      moveRule(doc, from, to);
    } catch {
      return;
    }
    this.docChange.emit(doc);
  }

  private resetDrag(): void {
    this.dragFrom.set(null);
    this.dropAt.set(null);
  }
}