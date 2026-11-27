import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { Backend } from './models';
import { AnyObj, groups, nodes, parseConfig } from './config-ops';
import { RouterService } from './router.service';
import { SharedPoolService } from './shared-pool.service';
import { errMsg } from './util';

/** 左侧「当前路由节点」行 */
interface SourceNode {
  tag: string;
  type: string;
  server: string;
  special: boolean;
  raw: AnyObj;
}

/**
 * 「共享编辑」面板 — 跨路由的共享池管理（先只做**节点**）：
 *   · 左：当前后端 config 里的节点，勾选或直接拖进右边的池子；
 *   · 右：共享池，按来源路由分组，可移除 / 导出 / 导入 JSON；
 *   · 池里的节点在「新增节点」弹窗的「共享池」页签里一键导入到另一台路由。
 *
 * 数据存浏览器 localStorage（同一浏览器内两个后端共用）；换设备用导出/导入 JSON 搬。
 */
@Component({
  selector: 'app-shared-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shared-panel.html',
})
export class SharedPanel implements OnInit {
  readonly backend = input<Backend | null>(null);
  readonly closed = output<void>();

  private readonly router = inject(RouterService);
  readonly pool = inject(SharedPoolService);

  /** 当前后端节点清单（读一次 config） */
  readonly src = signal<SourceNode[]>([]);
  readonly loading = signal(false);
  readonly err = signal('');
  readonly note = signal('');
  /** 勾选待加入的节点 tag */
  readonly picked = signal<string[]>([]);
  /** 抽屉：导入 JSON 的文本框 */
  readonly importOpen = signal(false);
  readonly importText = signal('');
  readonly exportOpen = signal(false);

  readonly groups = computed(() => this.pool.bySource());
  readonly total = computed(() => this.pool.nodes().length);

  /** 输入绑定完成后再读配置（构造函数里 input 还没赋值） */
  ngOnInit(): void {
    void this.loadSource();
  }

  private async loadSource(): Promise<void> {
    const b = this.backend();
    if (!b) {
      this.err.set('没有选中后端：先在上方选一个路由 tab');
      return;
    }
    this.loading.set(true);
    this.err.set('');
    try {
      const res = await this.router.config(b);
      const doc = parseConfig(res.config);
      const gs = new Set(groups(doc).map((g) => String(g['tag'])));
      const rows = nodes(doc).map((n) => ({
        tag: n.tag,
        type: n.type,
        server: n.server,
        special: n.special,
        raw: (doc.root['outbounds'] as AnyObj[]).find((o) => String(o['tag']) === n.tag) ?? {},
      }));
      // 特殊出站（DIRECT/REJECT）不是「节点」，不进共享候选
      this.src.set(rows.filter((r) => !r.special && !gs.has(r.tag)));
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /* ── 加入共享池 ── */

  togglePick(tag: string, on: boolean): void {
    this.picked.update((list) => (on ? [...new Set([...list, tag])] : list.filter((x) => x !== tag)));
  }

  isPicked(tag: string): boolean {
    return this.picked().includes(tag);
  }

  private addTags(tags: string[]): void {
    const b = this.backend();
    if (!b) return;
    const source = { api: b.api, name: b.name || b.api };
    const byTag = new Map(this.src().map((r) => [r.tag, r.raw]));
    let added = 0;
    let dup = 0;
    const bad: string[] = [];
    for (const t of tags) {
      const raw = byTag.get(t);
      if (!raw) continue;
      const res = this.pool.addNode(source, raw);
      if (!res.ok) bad.push(`${t}（${res.reason}）`);
      else if (res.dup) dup += 1;
      else added += 1;
    }
    this.picked.set([]);
    this.note.set(
      [added ? `已加入 ${added} 个` : '', dup ? `更新 ${dup} 个` : '', bad.length ? `跳过 ${bad.join('、')}` : '']
        .filter(Boolean)
        .join(' · ') || '没有变化',
    );
  }

  addPicked(): void {
    this.addTags(this.picked());
  }

  onDragStart(node: SourceNode, ev: DragEvent): void {
    ev.dataTransfer?.setData('text/plain', node.tag);
    this.dragTag.set(node.tag);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  readonly dragTag = signal<string | null>(null);
  readonly over = signal(false);

  onDragOver(ev: DragEvent): void {
    if (!this.dragTag()) return;
    ev.preventDefault();
    this.over.set(true);
  }

  onDragLeave(): void {
    this.over.set(false);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(false);
    const tag = this.dragTag() ?? ev.dataTransfer?.getData('text/plain') ?? '';
    this.dragTag.set(null);
    if (tag) this.addTags([tag]);
  }

  /* ── 池子操作 ── */

  remove(id: string): void {
    this.pool.removeNode(id);
    this.note.set('已从共享池移除');
  }

  clearAll(): void {
    this.pool.clear();
    this.note.set('共享池已清空');
  }

  openExport(): void {
    this.exportOpen.set(true);
    this.importOpen.set(false);
  }

  openImport(): void {
    this.importOpen.set(true);
    this.exportOpen.set(false);
  }

  doExport(): void {
    const text = this.pool.exportJson();
    this.importText.set(text);
    void navigator.clipboard?.writeText(text).then(
      () => this.note.set('已复制到剪贴板（也可以直接复制下面的文本）'),
      () => this.note.set('复制失败，请手动全选复制下面的文本'),
    );
  }

  doImport(): void {
    const res = this.pool.importJson(this.importText());
    this.note.set(res.ok ? `导入完成：新增 ${res.added} 个` : `导入失败：${res.error}`);
    if (res.ok) {
      this.importOpen.set(false);
      this.importText.set('');
    }
  }

  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closed.emit();
  }
}
