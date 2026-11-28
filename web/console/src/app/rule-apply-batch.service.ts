import { Injectable, inject, signal } from '@angular/core';
import { Backend } from './models';
import { RouterService } from './router.service';
import { ConfigDoc, applyGroupRefs, detachGroupRefs, parseConfig, routeRules, ruleSetRefs, serializeConfig } from './config-ops';
import { errMsg } from './util';

/** 一台路由在一个批次里的执行状态 */
export type BatchStepState = 'pending' | 'running' | 'ok' | 'skipped' | 'fail';

export interface BatchStep {
  backend: Backend;
  name: string;
  state: BatchStepState;
  /** 已经是目标状态（无需改动）时为 true：算成功，但不算「改了」 */
  unchanged: boolean;
  /** 套用阶段的结果说明（+x / −y / 新增 N 条） */
  detail: string;
  error: string;
  ms: number;
}

export interface BatchSummary {
  total: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

/** 一条共享规则的套用目标：所有「用得上这组」的路由（有同名出口） */
export type BatchMode = 'apply' | 'detach';

export interface ApplyPlan {
  group: string;
  refs: string[];
  mode: BatchMode;
  steps: BatchStep[];
}

/**
 * 共享规则的「批量套用」编排。
 *
 * 与单路由草稿（ConfigDraftService）的区别：
 *   · 不经过「暂存 → 用户再点保存」那一层，而是一次弹窗里把 N 台路由**逐台**做完；
 *   · 每台独立走完整链路：读配置 → 套用 refs → sing-box check → apply（备份→替换→重启→健康→失败回滚）；
 *   · 一台失败不阻断其它路由（各路由的失败回滚由 99 侧保证，不会改坏）；
 *   · 已经与目标一致的路由直接「跳过（已一致）」，不白白重启。
 */
@Injectable({ providedIn: 'root' })
export class RuleApplyBatchService {
  private readonly router = inject(RouterService);

  readonly running = signal(false);
  readonly steps = signal<BatchStep[]>([]);
  readonly summary = signal<BatchSummary | null>(null);
  /** 正在执行第几台（1-based，给进度条用） */
  readonly currentIdx = signal(0);

  private cancelRequested = false;

  /** 预演：只读各路由配置，算出哪些要改、哪些已一致、哪些没有同名出口 */
  async plan(group: string, refs: string[], backends: Backend[], mode: BatchMode = 'apply'): Promise<ApplyPlan> {
    const steps: BatchStep[] = [];
    for (const b of backends) {
      const step: BatchStep = {
        backend: b,
        name: b.name || b.api,
        state: 'pending',
        unchanged: false,
        detail: '',
        error: '',
        ms: 0,
      };
      try {
        const res = await this.router.config(b);
        const doc = parseConfig(res.config);
        const probe = structuredClone(doc);
        if (mode === 'detach') {
          const r = detachGroupRefs(probe, group, refs);
          if (r.removed === 0) {
            step.state = 'skipped';
            step.unchanged = true;
            step.detail = '没有挂着这条共享规则，无需解除';
          } else {
            step.detail = `将撤掉 ${r.removed} 条共享规则（出口与组内节点不动）`;
          }
        } else {
          const r = applyGroupRefs(probe, group, refs);
          if (!r.ok) {
            step.state = 'skipped';
            step.detail = r.reason ?? '不适用';
          } else if (r.insertedAt === undefined && !r.added.length && !r.removed.length && !r.removedRules) {
            step.state = 'skipped';
            step.unchanged = true;
            step.detail = '已与共享规则一致，无需改动';
          } else {
            step.detail =
              r.insertedAt !== undefined
                ? `将新增 1 条规则（出口 ${group}）`
                : `将改：+${r.added.length} / −${r.removed.length} 个规则集` +
                  (r.removedRules ? `，合并 ${r.removedRules} 条` : '');
          }
        }
      } catch (e) {
        step.state = 'skipped';
        step.detail = `读不到配置：${errMsg(e)}`;
      }
      steps.push(step);
    }
    return { group, refs, mode, steps };
  }

  /** 有几台真的要动（决定「开始」按钮是否可点） */
  pendingCount(plan: ApplyPlan): number {
    return plan.steps.filter((s) => s.state === 'pending').length;
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  /**
   * 逐台执行。每台都是完整链路，失败不阻断；返回汇总。
   * 注意：这里直接 apply 到路由（用户已在弹窗里确认过计划）。
   */
  async run(plan: ApplyPlan): Promise<BatchSummary> {
    if (this.running()) return this.summary()!;
    this.cancelRequested = false;
    this.running.set(true);
    this.summary.set(null);
    this.steps.set(plan.steps.map((s) => ({ ...s, ms: 0 })));
    const t0All = Date.now();

    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = this.steps()[i];
      if (step.state !== 'pending') continue; // 预演时已判定 跳过/已一致
      if (this.cancelRequested) {
        this.patch(i, { state: 'skipped', detail: '已取消，未执行' });
        continue;
      }
      this.currentIdx.set(i + 1);
      this.patch(i, { state: 'running', detail: '读取配置…', error: '' });
      const t0 = Date.now();
      try {
        await this.applyOne(step.backend, plan.group, plan.refs, plan.mode, (msg) => this.patch(i, { detail: msg }));
        this.patch(i, { state: 'ok', ms: Date.now() - t0 });
      } catch (e) {
        this.patch(i, { state: 'fail', error: errMsg(e), ms: Date.now() - t0 });
      }
    }

    const all = this.steps();
    const summary: BatchSummary = {
      total: all.length,
      changed: all.filter((s) => s.state === 'ok').length,
      unchanged: all.filter((s) => s.state === 'skipped' && s.unchanged).length,
      skipped: all.filter((s) => s.state === 'skipped' && !s.unchanged).length,
      failed: all.filter((s) => s.state === 'fail').length,
    };
    this.summary.set(summary);
    this.running.set(false);
    this.currentIdx.set(0);
    void t0All;
    return summary;
  }

  private patch(i: number, p: Partial<BatchStep>): void {
    this.steps.update((list) => list.map((s, idx) => (idx === i ? { ...s, ...p } : s)));
  }

  /** 单台完整链路：读 → 套用 → check → apply */
  private async applyOne(
    b: Backend,
    group: string,
    refs: string[],
    mode: BatchMode,
    progress: (msg: string) => void,
  ): Promise<void> {
    progress('读取配置…');
    const res = await this.router.config(b);
    const doc = parseConfig(res.config);
    let what: string;
    if (mode === 'detach') {
      const r = detachGroupRefs(doc, group, refs);
      if (!r.removed) throw new Error('没有可解除的共享规则');
      what = `已撤掉 ${r.removed} 条共享规则`;
    } else {
      const r = applyGroupRefs(doc, group, refs);
      if (!r.ok) throw new Error(r.reason);
      what =
        r.insertedAt !== undefined
          ? '新增 1 条规则'
          : `+${r.added.length} / −${r.removed.length} 规则集`;
    }
    const text = serializeConfig(doc, res.config);
    progress('sing-box check…');
    const chk = await this.router.check(b, text);
    if (!chk.ok) throw new Error(`sing-box check 未通过：${(chk.output || '').trim().slice(0, 300)}`);
    progress('备份 → 替换 → 重启…');
    const out = await this.router.apply(b, text, res.sha256);
    // 99 的 apply 是同步的：备份→替换→重启→健康检查→失败回滚全部做完才返回；
    // 失败走非 2xx（上面 catch），这里只兜底 ok=false
    if (out && out.ok === false) throw new Error(`应用失败：${(out.log || '').trim().slice(0, 300) || '路由返回 ok=false'}`);
    // changed=false：内容其实没变（99 侧比对），未重启 —— 如实告诉用户
    progress(out.changed === false ? `${what} · 内容未变，未重启` : `${what} · 已重启并健康`);
  }

  /** 供测试/展示：一份文档套用后规则集合是否与目标一致 */
  static isConsistent(doc: ConfigDoc, group: string, refs: string[]): boolean {
    const cur: string[] = [];
    for (const rule of routeRules(doc)) {
      if (String(rule['outbound'] ?? '') !== group) continue;
      for (const x of ruleSetRefs(rule)) if (!cur.includes(x)) cur.push(x);
    }
    const a = [...cur].sort().join('\n');
    const b = [...new Set(refs)].sort().join('\n');
    return a === b;
  }
}
