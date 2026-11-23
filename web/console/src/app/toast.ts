import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from './toast.service';

/**
 * Toast — 右下角提示条堆叠（取代 alert()）。
 * 样式见 styles.css 的 .toast-stack / .toast；点一条即关，到点自动消失。
 */
@Component({
  selector: 'app-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" aria-live="polite">
      @for (t of svc.items(); track t.id) {
        <div class="toast" [class.ok]="t.kind === 'ok'" [class.bad]="t.kind === 'bad'" (click)="svc.dismiss(t.id)">
          <span class="toast-ico">{{ t.kind === 'ok' ? '✓' : t.kind === 'bad' ? '✗' : 'ℹ' }}</span>
          <span class="toast-text">{{ t.text }}</span>
        </div>
      }
    </div>
  `,
})
export class Toast {
  readonly svc = inject(ToastService);
}