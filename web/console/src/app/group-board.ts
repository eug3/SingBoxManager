import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ConfigDoc, GROUP_TYPES } from './config-ops';
import { BoardData, BoardMeta, moveMember, readBoard } from './group-board-model';

/**
 * 分组看板 — 配置页只读视图里的拖拽看板：横向「未分组 + 每个分组」一列，
 * 把节点 chip 拖到某个分组列 = 加入该组；拖回「未分组」= 从所有分组移除。
 *
 * 重启语义（顶部图例同步展示）：
 *  · 改分组成员 = 改 config 结构 → 需「应用并重启」（约 1s 断流）；
 *  · 改 remote 桶内容 → 免重启，约 60s 自动生效（那是「规则编辑」tab 的事）。
 *
 * base 固定来自原始配置（ConfigPane.origDoc），不随暂存文本漂移；每次放下都用
 * moveMember 从 base 生成一份新 ConfigDoc，经 docChange 交给 ConfigPane.enterReview，
 * 走既有的「暂存 → diff → 应用并重启」流程。拖动本身只改浏览器里的文档，不碰路由。
 */
@Component({
  selector: 'app-group-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './group-board.html',
})
export class GroupBoard {
  readonly base = input<ConfigDoc | null>(null);
  readonly docChange = output<ConfigDoc>();

  /** 正在拖的条目 tag（dragover 里拿不到 dataTransfer 内容，只能靠它） */
  readonly dragging = signal<string | null>(null);
  /** 高亮中的列键：分组 tag，或下面的 poolColumn */
  readonly overGroup = signal<string | null>(null);

  /** 「未分组」列的列键：用 \u0000 打头保证不会和真实 tag 撞车 */
  readonly poolColumn = '\u0000pool';

  readonly board = computed<BoardData>(() => {
    const b = this.base();
    return b ? readBoard(b) : { groups: [], pool: [], meta: {} };
  });

  // ---------- 模板用的只读派生 ----------

  /** 条目元信息（组引用里可能有已不存在的 tag，兜底成 '?'） */
  metaOf(tag: string): BoardMeta {
    return this.board().meta[tag] ?? { type: '?', special: false };
  }

  /** 该 tag 本身是不是分组（嵌套在别的组里的 selector/urltest） */
  isGroupTag(tag: string): boolean {
    return GROUP_TYPES.has(this.metaOf(tag).type);
  }

  /** chip 悬浮提示：类型 + 服务器 + 嵌套分组的行为说明 */
  chipTitle(tag: string): string {
    const m = this.metaOf(tag);
    const parts = [m.type];
    if (m.server) parts.push(m.server);
    if (this.isGroupTag(tag)) parts.push('这是分组：不能拖进别的分组，可以拖回「未分组」取消嵌套');
    return parts.join(' · ');
  }

  // ---------- HTML5 原生拖拽 ----------

  onDragStart(tag: string, ev: DragEvent): void {
    this.dragging.set(tag);
    const dt = ev.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'move';
    try {
      dt.setData('text/plain', tag); // 部分浏览器要求 setData 才肯触发 drop
    } catch {
      /* 隐私模式下可能被拒，忽略即可（拖拽仍靠 dragging() 工作） */
    }
  }

  onDragEnd(): void {
    this.dragging.set(null);
    this.overGroup.set(null);
  }

  onDragOver(column: string, ev: DragEvent): void {
    const tag = this.dragging();
    if (!tag) return;
    // 目标不合法（分组拖进分组 / 已在该组 / 本来就在池里）就不阻止默认：
    // 浏览器自己会显示「禁止放下」，也不会再触发 drop
    if (!this.canDrop(tag, this.targetOf(column))) return;
    ev.preventDefault();
    const dt = ev.dataTransfer;
    if (dt) dt.dropEffect = 'move';
    if (this.overGroup() !== column) this.overGroup.set(column);
  }

  onDragLeave(column: string, ev: DragEvent): void {
    const el = ev.currentTarget as HTMLElement | null;
    const to = ev.relatedTarget as Node | null;
    if (el && to && el.contains(to)) return; // 在列内 chip 之间移动，不算离开
    if (this.overGroup() === column) this.overGroup.set(null);
  }

  onDrop(column: string, ev: DragEvent): void {
    ev.preventDefault();
    const fromEvent = ev.dataTransfer?.getData('text/plain') ?? '';
    const tag = this.dragging() ?? fromEvent;
    this.dragging.set(null);
    this.overGroup.set(null);
    const base = this.base();
    if (!base || !tag) return;
    const next = moveMember(base, tag, this.targetOf(column));
    if (next) this.docChange.emit(next); // 非法或无改动时不发，避免覆盖已有暂存
  }

  // ---------- 内部 ----------

  /** 列键 → moveMember 的 targetGroup（null = 未分组） */
  private targetOf(column: string): string | null {
    return column === this.poolColumn ? null : column;
  }

  /** 这次放下会不会真的产生改动（决定高亮与是否允许放下） */
  private canDrop(tag: string, target: string | null): boolean {
    const b = this.board();
    if (target === null) return b.groups.some((g) => g.members.includes(tag));
    if (this.isGroupTag(tag)) return false; // 分组不能拖进分组
    const g = b.groups.find((x) => x.tag === target);
    return !!g && !g.members.includes(tag);
  }
}
