import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ConfigDoc, addGroup, groups, nodes } from './config-ops';

/** urltest 缺省参数（与 group-dialog 同一口径：sing-box 官方默认） */
const URLTEST_DEFAULT_URL = 'https://www.gstatic.com/generate_204';
const URLTEST_DEFAULT_INTERVAL = '3m';
const URLTEST_DEFAULT_TOLERANCE = 50;

/** 候选成员行 */
interface MemberCandidate {
  tag: string;
  type: string;
  /** 其它分组（可嵌套） */
  isGroup: boolean;
  /** direct/block/dns 这类特殊出站 */
  special: boolean;
}

/**
 * ④ 列头「＋」新建分组弹窗 — 建一个 selector / urltest 出站并直接勾好成员。
 *
 * 成员列表与 group-dialog 同口径：全部非分组条目（节点 + direct/block + endpoints）
 * 在前，其它分组（可嵌套）在后；「负载均衡」是 urltest + tolerance 0 + 1m 的预设
 * （sing-box 没有原生轮询负载均衡，见 docs/plan-flow-edit.md 第 6 节）。
 *
 * 只产出新文档（docChange），写回由调用方决定：流向页走 ConfigDraftService.stage，
 * 配置页走 enterReview。
 */
@Component({
  selector: 'app-group-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './group-create-dialog.html',
})
export class GroupCreateDialog {
  /** 编辑基准（当前暂存草稿优先） */
  readonly base = input<ConfigDoc | null>(null);
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  /** 新分组 tag */
  readonly tag = signal('');
  /** select 值：selector / urltest / balance（balance = urltest 严格最快预设） */
  readonly type = signal<'selector' | 'urltest' | 'balance'>('selector');
  /** urltest 参数 */
  readonly url = signal('');
  readonly interval = signal('');
  readonly tolerance = signal('');
  /** 已勾成员（按勾选顺序） */
  readonly members = signal<string[]>([]);
  /** 成员检索词 */
  readonly q = signal('');
  /** 表单错误 */
  readonly err = signal('');

  /** 候选成员：非分组条目 + 其它分组 */
  readonly candidates = computed<MemberCandidate[]>(() => {
    const d = this.base();
    if (!d) return [];
    const list: MemberCandidate[] = nodes(d).map((n) => ({
      tag: n.tag,
      type: n.type,
      isGroup: false,
      special: n.special,
    }));
    for (const g of groups(d)) {
      list.push({ tag: String(g['tag']), type: String(g['type']), isGroup: true, special: false });
    }
    return list;
  });

  /** 检索后的候选成员 */
  readonly candidatesFiltered = computed<MemberCandidate[]>(() => {
    const kw = this.q().trim().toLowerCase();
    const all = this.candidates();
    if (!kw) return all;
    return all.filter(
      (c) =>
        c.tag.toLowerCase().includes(kw) ||
        c.type.toLowerCase().includes(kw) ||
        (c.isGroup && '分组'.includes(kw)),
    );
  });

  /** 是否 urltest（含 balance 预设） */
  readonly isAuto = computed(() => this.type() !== 'selector');

  /** 检索不区分大小写的清空 */
  clearQ(): void {
    this.q.set('');
  }

  /** 勾选 / 取消一个成员 */
  toggleMember(tag: string, on: boolean): void {
    this.members.update((list) => {
      const has = list.includes(tag);
      if (on && !has) return [...list, tag];
      if (!on && has) return list.filter((x) => x !== tag);
      return list;
    });
  }

  isMember(tag: string): boolean {
    return this.members().includes(tag);
  }

  /** 提交：克隆基准 → addGroup → 抛给调用方暂存 */
  submit(): void {
    const base = this.base();
    if (!base) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const tag = this.tag().trim();
    if (!tag) {
      this.err.set('分组 tag 不能为空');
      return;
    }
    if (!this.members().length) {
      this.err.set('至少勾一个成员（节点 / DIRECT / 其它分组）');
      return;
    }
    const doc: ConfigDoc = structuredClone(base);
    const kind = this.type();
    try {
      addGroup(doc, {
        tag,
        type: kind === 'selector' ? 'selector' : 'urltest',
        members: this.members(),
        url: kind === 'balance' ? URLTEST_DEFAULT_URL : this.url(),
        interval: kind === 'balance' ? '1m' : this.interval(),
        tolerance:
          kind === 'balance'
            ? 0
            : kind === 'urltest'
              ? this.numberOrNull(this.tolerance(), URLTEST_DEFAULT_TOLERANCE)
              : null,
      });
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
      return;
    }
    this.err.set('');
    this.docChange.emit(doc);
    this.closed.emit();
  }

  /** 数字输入 → number（空/非法时取兜底） */
  private numberOrNull(v: string, fallback: number): number | null {
    const t = v.trim();
    if (!t) return fallback;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  close(): void {
    this.closed.emit();
  }

  /** 点遮罩空白处关闭（点弹窗本体不关） */
  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}