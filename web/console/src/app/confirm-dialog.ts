import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from './confirm.service';

/**
 * ConfirmDialog — 页内确认框（取代原生 confirm()）。
 *
 * 实现要点：
 *  · 用原生 <dialog> + showModal()：浏览器自带顶层遮罩、焦点约束、ESC 取消，
 *    且完全不受「阻止此页面创建更多对话框」影响；
 *  · 视觉复用现有 .modal / .modal-hd / .modal-body / .modal-ft，风格与其它弹窗一致；
 *  · 点遮罩空白 = 取消；ESC = 取消；确认/取消都结算 ConfirmService 的 Promise；
 *  · 关闭走 <dialog>.close()（不是删 DOM），浏览器会把焦点还给触发按钮。
 *
 * 只由 ConfirmService 驱动，不在任何业务模板里手动开关。
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="cfm-dialog" (cancel)="onCancel($event)" (click)="onBackdrop($event)">
      @if (svc.current(); as c) {
        <div class="modal cfm">
          <div class="modal-hd">
            <b>{{ c.title }}</b>
            <button type="button" class="x" (click)="svc.settle(false)" title="取消">✕</button>
          </div>
          <div class="modal-body">
            @if (c.body) {
              <div class="cfm-body">{{ c.body }}</div>
            }
            @if (c.details?.length) {
              <ul class="cfm-list">
                @for (d of c.details ?? []; track $index) {
                  <li>{{ d }}</li>
                }
              </ul>
            }
          </div>
          <div class="modal-ft">
            <span class="cfm-spacer"></span>
            <button type="button" class="cfm-cancel" (click)="svc.settle(false)">{{ c.cancelText }}</button>
            <button type="button" class="cfm-ok" [class.acc]="!c.danger" [class.danger]="c.danger"
                    (click)="svc.settle(true)">
              {{ c.okText }}
            </button>
          </div>
        </div>
      }
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly svc = inject(ConfirmService);
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    // 有请求 → 打开原生 modal；请求结算 → close()（焦点回触发按钮）；队列换下一个时内容随绑定刷新
    effect(() => {
      const c = this.svc.current();
      const el = this.dlg()?.nativeElement;
      if (!el) return;
      if (!c) {
        if (el.open) el.close();
        return;
      }
      if (!el.open) el.showModal();
      // 内容由同一轮 CD 渲染，effect 可能先于视图刷新：放到下一拍再抢焦点（危险操作给「取消」）
      const id = c.id;
      setTimeout(() => {
        if (this.svc.current()?.id !== id) return;
        el.querySelector<HTMLButtonElement>(c.danger ? '.cfm-cancel' : '.cfm-ok')?.focus();
      }, 0);
    });
  }

  /** ESC：浏览器会先发 cancel，这里拦下改成结算 false */
  onCancel(ev: Event): void {
    ev.preventDefault();
    this.svc.settle(false);
  }

  /** 点遮罩空白（target 是 dialog 本身）= 取消；点弹窗内部不处理 */
  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.svc.settle(false);
  }
}