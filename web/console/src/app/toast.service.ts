import { Injectable, signal } from '@angular/core';

/** Toast 语气：ok=成功，bad=失败，info=普通提示 */
export type ToastKind = 'ok' | 'bad' | 'info';

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

/**
 * ToastService — 取代 alert() 的页内提示条。
 *
 * 与原生 alert 的区别：不阻塞、不被浏览器「阻止对话框」策略静默、可叠多条。
 * 用法：this.toast.error('规则拉取失败：' + msg) / this.toast.ok('已保存')
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  /** 当前显示的提示条（右下角堆叠） */
  readonly items = signal<ToastItem[]>([]);

  private seq = 0;

  /** 弹一条提示；ms 到点自动消失（点一下也能立刻关掉） */
  show(text: string, kind: ToastKind = 'info', ms = 4000): void {
    if (!text) return;
    const id = ++this.seq;
    this.items.update((list) => [...list, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), ms);
  }

  /** 失败提示（停留更久，够读完错误原文） */
  error(text: string): void {
    this.show(text, 'bad', 6500);
  }

  /** 成功提示 */
  ok(text: string): void {
    this.show(text, 'ok');
  }

  /** 关掉某条 */
  dismiss(id: number): void {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }
}