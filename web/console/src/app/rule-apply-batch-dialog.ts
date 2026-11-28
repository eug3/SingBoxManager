import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { Backend } from './models';
import { ApplyPlan, BatchStep, RuleApplyBatchService } from './rule-apply-batch.service';
import { errMsg } from './util';

type Phase = 'planning' | 'confirm' | 'running' | 'done';

/**
 * 共享规则「应用到所有路由」的弹窗：
 *   planning → 读各路由配置，算出每台要改什么
 *   confirm  → 列出计划（改 / 已一致 / 不适用），用户点「开始」才真动路由
 *   running  → 逐台执行，每台实时显示状态
 *   done     → 汇总（成功 N / 已一致 N / 跳过 N / 失败 N），失败项给出原因
 */
@Component({
  selector: 'app-rule-apply-batch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-apply-batch-dialog.html',
})
export class RuleApplyBatchDialog implements OnInit {
  readonly group = input.required<string>();
  readonly refs = input.required<string[]>();
  readonly backends = input.required<Backend[]>();
  readonly closed = output<void>();
  /** 全部跑完后通知父组件刷新状态 */
  readonly finished = output<void>();

  private readonly batch = inject(RuleApplyBatchService);

  readonly phase = signal<Phase>('planning');
  readonly plan = signal<ApplyPlan | null>(null);
  readonly planError = signal('');

  /** 表格数据源：confirm 用预演结果，running/done 用实时执行状态 */
  readonly steps = computed(() => (this.phase() === 'confirm' ? (this.plan()?.steps ?? []) : this.batch.steps()));
  readonly summary = this.batch.summary;
  readonly currentIdx = this.batch.currentIdx;

  /** 真正需要动的台数（confirm 阶段按预演结果算；running/done 阶段读实时 steps） */
  readonly pendingTotal = computed(() => {
    const src = this.phase() === 'confirm' ? (this.plan()?.steps ?? []) : this.steps();
    return src.filter((s) => s.state === 'pending' || s.state === 'running' || s.state === 'ok' || s.state === 'fail').length;
  });

  /** 真正需要动的路由（confirm 页高亮） */
  readonly toChange = computed(() => (this.plan()?.steps ?? []).filter((s) => s.state === 'pending'));

  /** input.required 在构造函数里还没就绪（会抛 NG0950），必须等 ngOnInit */
  ngOnInit(): void {
    void this.makePlan();
  }

  private async makePlan(): Promise<void> {
    this.phase.set('planning');
    this.planError.set('');
    try {
      const p = await this.batch.plan(this.group(), this.refs(), this.backends());
      this.plan.set(p);
      this.phase.set('confirm');
    } catch (e) {
      this.planError.set(errMsg(e));
    }
  }

  start(): void {
    const p = this.plan();
    if (!p || !this.pendingTotal()) return;
    this.phase.set('running');
    void this.batch.run(p).then(() => {
      this.phase.set('done');
      this.finished.emit();
    });
  }

  cancelRun(): void {
    this.batch.cancel();
  }

  /** 运行中不允许点遮罩关闭，避免误以为后台停了 */
  onMask(ev: MouseEvent): void {
    if (this.phase() === 'running') return;
    if (ev.target === ev.currentTarget) this.close();
  }

  close(): void {
    if (this.phase() === 'running') return;
    this.closed.emit();
  }

  icon(s: BatchStep): string {
    switch (s.state) {
      case 'ok':
        return '✓';
      case 'fail':
        return '✗';
      case 'running':
        return '…';
      case 'skipped':
        return s.unchanged ? '＝' : '–';
      default:
        return '○';
    }
  }

  stateText(s: BatchStep): string {
    switch (s.state) {
      case 'ok':
        return s.ms ? `成功 · ${s.ms}ms` : '成功';
      case 'fail':
        return '失败';
      case 'running':
        return `执行中（第 ${this.currentIdx()} 台）`;
      case 'skipped':
        return s.unchanged ? '已一致，跳过' : '不适用，跳过';
      default:
        return '待执行';
    }
  }
}
