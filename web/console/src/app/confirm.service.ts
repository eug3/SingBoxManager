import { Injectable, signal } from '@angular/core';

/** 一次确认请求的可配置项（文案全部由调用方给，保证各处口径不变） */
export interface ConfirmOptions {
  /** 标题（一句话说清要做什么） */
  title: string;
  /** 正文（可省略）；多行用 \n 或直接传字符串，模板按预格式展示 */
  body?: string;
  /** 明细清单（结构校验问题、删除影响等逐条列出） */
  details?: string[];
  /** 确认按钮文案（默认「确认」） */
  okText?: string;
  /** 取消按钮文案（默认「取消」） */
  cancelText?: string;
  /** 危险操作：确认按钮转红、默认焦点落在取消上 */
  danger?: boolean;
}

/** 内部状态：补全默认文案与自增 id（@if / @for 追踪用） */
export interface ConfirmRequest extends ConfirmOptions {
  id: number;
  okText: string;
  cancelText: string;
}

/**
 * ConfirmService — 取代 window.confirm() 的页内确认框。
 *
 * 为什么不用原生 confirm：浏览器（Chrome/Edge）允许「阻止此页面创建更多对话框」，
 * 被拦截后 confirm() 直接返回 false，点击就完全静默——按钮看起来毫无反应。
 * 这里改成 signal 驱动的页内弹窗，任何浏览器弹窗策略都影响不到，且视觉与
 * 现有 .modal-* 弹窗一致。
 *
 * 用法（保持原 confirm 的调用习惯，只是多一个 await）：
 *   if (!(await this.ui.ask({ title: '删除后端「甲」？', danger: true }))) return;
 *
 * 并发安全：多个请求排队逐个显示，先出结论的只结算自己那个 Promise。
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  /** 当前正在显示的确认框（null = 没有） */
  readonly current = signal<ConfirmRequest | null>(null);

  /** 待显示的队列（当前为空时直接显示队首） */
  private readonly queue: { req: ConfirmRequest; resolve: (ok: boolean) => void }[] = [];
  private seq = 0;

  /** 弹一个确认框，等待用户点「确认/取消」（ESC、点遮罩都算取消） */
  ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req: ConfirmRequest = {
        ...opts,
        id: ++this.seq,
        okText: opts.okText ?? '确认',
        cancelText: opts.cancelText ?? '取消',
      };
      this.queue.push({ req, resolve });
      if (!this.current()) this.current.set(req);
    });
  }

  /** 结算当前确认框；队列里还有下一个就立刻换上 */
  settle(ok: boolean): void {
    const cur = this.queue.shift();
    if (!cur) return;
    this.current.set(this.queue[0]?.req ?? null);
    cur.resolve(ok);
  }
}