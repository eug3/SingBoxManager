import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** 保存流程的每个阶段 */
export type SaveStep = 'prep' | 'upload' | 'check' | 'restart' | 'verify';

/** 阶段定义：顺序即执行顺序 */
export const SAVE_STEPS: { key: SaveStep; label: string; hint: string }[] = [
  { key: 'prep', label: '读取当前配置', hint: '核对基准版本，防止覆盖他人改动' },
  { key: 'upload', label: '上传并备份', hint: '先把现役配置备份到路由，再写入候选配置' },
  { key: 'check', label: '语法校验', hint: 'sing-box check 逐个检查配置合法性' },
  { key: 'restart', label: '重启 sing-box', hint: '断流约 1 秒' },
  { key: 'verify', label: '健康检查', hint: '确认进程起来、clash_api 有响应；不健康会自动回滚' },
];

/**
 * 保存进度弹窗 — 把「保存并重启」的黑盒过程摊开：
 *  · running：一步一步点亮，当前步有转圈，顶部显示已用时；
 *  · ok：全部打勾 + 摘要（写入大小 / 耗时 / 是否变更）；
 *  · fail：停在出错那步（红叉），给出错误原文与建议，可重试；
 *  · needCreds：提示缺 SSH 凭据，交回父组件开凭据框。
 *
 * 注意：后端 apply 是一条阻塞的 SSH 调用，阶段推进按耗时估计（estimate），
 * 结束时以真实结果为准 —— 所以绝不显示百分比数字，只显示「进行到哪一步」。
 */
@Component({
  selector: 'app-save-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <div class="modal-mask" (click)="onMask($event)">
      <div class="modal sp-modal" role="dialog" aria-modal="true" aria-live="polite"
           [attr.aria-label]="'保存配置到 ' + host()">
        <div class="modal-hd">
          <b>
            @switch (state()) {
              @case ('ok') { ✓ 保存成功 }
              @case ('fail') { ✗ 保存失败 }
              @case ('needCreds') { 🔑 需要 SSH 凭据 }
              @default { 正在保存到路由 }
            }
          </b>
          <span class="dim small">{{ host() }}</span>
          @if (state() !== 'running') {
            <button class="x" (click)="close.emit()" title="关闭">✕</button>
          }
        </div>

        <div class="modal-body">
          <!-- 进行中：步骤清单 -->
          <div class="sp-steps">
            @for (s of steps(); track s.key) {
              @let st = stepState(s.key);
              <div class="sp-step" [class.done]="st === 'done'" [class.active]="st === 'active'" [class.failed]="st === 'failed'">
                <span class="sp-ico">
                  @switch (st) {
                    @case ('done') { ✓ }
                    @case ('failed') { ✗ }
                    @case ('active') { <span class="sp-spin"></span> }
                    @default { <span class="sp-dot"></span> }
                  }
                </span>
                <span class="sp-body">
                  <span class="sp-label">{{ s.label }}</span>
                  <span class="sp-hint">{{ s.hint }}</span>
                </span>
                @if (st === 'active' && state() === 'running') {
                  <span class="sp-elapsed">{{ elapsedText() }}</span>
                }
              </div>
            }
          </div>

          <!-- 成功摘要 -->
          @if (state() === 'ok') {
            <div class="sp-result ok">
              <div><b>配置已写回并生效</b>@if (changed() === false) { <span class="dim">（内容与线上一致，未产生变更）</span> }</div>
              <div class="dim small">用时 {{ elapsedText() }}@if (size()) { · 写入 {{ size() }} B }</div>
              @if (warn()) {
                <div class="sp-warn">⚠ {{ warn() }}</div>
              }
            </div>
          }

          <!-- 失败详情 -->
          @if (state() === 'fail') {
            <div class="sp-result bad">
              <div><b>{{ failTitle() }}</b></div>
              @if (error()) { <pre class="sp-err">{{ error() }}</pre> }
              <div class="dim small">{{ failHint() }}</div>
            </div>
          }

          <!-- 缺凭据 -->
          @if (state() === 'needCreds') {
            <div class="sp-result warn">
              <div><b>需要该路由的 SSH 用户名与口令</b></div>
              <div class="dim small">保存时要登录路由写配置并重启，请填写凭据；填好后会自动继续保存。</div>
            </div>
          }
        </div>

        <div class="modal-ft">
          @switch (state()) {
            @case ('ok') {
              <span class="dim small">待保存改动已清空</span>
              <button class="acc" (click)="close.emit()">完成</button>
            }
            @case ('fail') {
              <span class="dim small">{{ failFoot() }}</span>
              <button (click)="close.emit()">关闭</button>
              <button class="acc" (click)="retry.emit()">重试</button>
            }
            @case ('needCreds') {
              <span class="spacer"></span>
              <button (click)="close.emit()">取消</button>
              <button class="acc" (click)="askCreds.emit()">填写凭据</button>
            }
            @default {
              <span class="dim small">过程不可中断，请稍候…</span>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class SaveProgressDialog {
  /** 目标路由名（标题旁显示） */
  readonly host = input<string>('');
  /** 流程状态 */
  readonly state = input<'running' | 'ok' | 'fail' | 'needCreds'>('running');
  /** 当前进行到第几步（0-based；running 时有效） */
  readonly current = input<number>(0);
  /** 已用毫秒（父组件计时） */
  readonly elapsedMs = input<number>(0);
  /** 失败原因原文 */
  readonly error = input<string>('');
  /** 失败标题（如「语法校验未通过」） */
  readonly failTitle = input<string>('保存失败');
  /** 失败建议（父组件按错误类型给） */
  readonly failHint = input<string>('');
  /** 写入字节数（成功摘要用） */
  readonly size = input<number>(0);
  /** 是否产生实际变更（false = 内容与线上一致） */
  readonly changed = input<boolean | undefined>(undefined);
  /** 成功态下的非致命警告（例如「已写回但刷新配置失败」） */
  readonly warn = input<string>('');
  /** 失败态底部说明（父组件按错误类型给；网络类错误不能说「已自动回滚」） */
  readonly failFoot = input<string>('路由未被改坏时已自动回滚到原配置');

  readonly close = output<void>();
  readonly retry = output<void>();
  readonly askCreds = output<void>();

  readonly steps = computed(() => SAVE_STEPS);

  /** 某一步的状态：已完成 / 进行中 / 失败 / 未开始 */
  stepState(key: SaveStep): 'done' | 'active' | 'failed' | 'todo' {
    const idx = SAVE_STEPS.findIndex((s) => s.key === key);
    const cur = this.current();
    if (this.state() === 'fail' && idx === cur) return 'failed';
    if (this.state() === 'ok' || idx < cur) return 'done';
    if (idx === cur) return 'active';
    return 'todo';
  }

  /** 已用时：3.2 秒 / 1 分 05 秒 */
  elapsedText(): string {
    const ms = Math.max(0, this.elapsedMs());
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' 秒';
    const m = Math.floor(s / 60);
    return `${m} 分 ${String(Math.floor(s % 60)).padStart(2, '0')} 秒`;
  }

  /** 点遮罩空白处：只在结束后允许关闭（进行中不可关） */
  onMask(ev: MouseEvent): void {
    if (ev.target !== ev.currentTarget) return;
    if (this.state() !== 'running') this.close.emit();
  }
}