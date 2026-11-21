import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { CONSOLE_VERSION, PAGE_ORIGINS } from './models';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackendPane, RuleEditor],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly bsvc = inject(BackendsService);
  private readonly clash = inject(ClashService);
  readonly version = CONSOLE_VERSION;
  /** 底部信息条：当前生效后端的 sing-box 版本 */
  readonly sbVersion = signal('');
  readonly backends = this.bsvc.backends;
  readonly active = signal<string>(this.backends().length ? 'b0' : 'edit');
  readonly originOk = PAGE_ORIGINS.includes(location.origin);
  readonly origins = PAGE_ORIGINS;
  readonly keyDraft = signal(this.bsvc.globalKey());

  constructor() {
    effect(() => {
      const b = this.backends().find((x) => this.bsvc.valid(x));
      void this.loadVersion(b);
    });
  }

  private async loadVersion(b: ReturnType<BackendsService['backends']>[number] | undefined): Promise<void> {
    if (!b) {
      this.sbVersion.set('');
      return;
    }
    try {
      const v = await this.clash.version(b);
      this.sbVersion.set(v?.version ?? '');
    } catch {
      this.sbVersion.set('');
    }
  }

  onKey(v: string): void {
    this.keyDraft.set(v);
    this.bsvc.setGlobalKey(v);
  }

  addBackend(): void {
    const i = this.bsvc.addDraft();
    this.active.set('b' + i);
  }

  onRemoved(): void {
    this.active.set(this.backends().length ? 'b0' : 'edit');
  }
}