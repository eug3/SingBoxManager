import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { Backend, CONSOLE_VERSION, PAGE_ORIGINS } from './models';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackendPane, RuleEditor],
  templateUrl: './app.html',
})
/**
 * 根组件 — 顶栏（标题）+ 主 tab（各后端面板 / 规则编辑）+ 底部信息条。
 * 密钥不在顶栏填写：统一走「配置」页的连接门禁或各后端「⚙ 后端配置」。
 * 布局：100dvh 固定壳，滚动只发生在各面板内部（见 styles.css）。
 */
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

  constructor() {
    effect(() => {
      const b = this.backends().find((x) => this.bsvc.valid(x));
      void this.loadVersion(b);
    });
  }

  /** 底部信息条的 sing-box 版本：取第一个有效后端探测 */
  private async loadVersion(b: Backend | undefined): Promise<void> {
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

  addBackend(): void {
    const i = this.bsvc.addDraft();
    this.active.set('b' + i);
  }

  onRemoved(): void {
    this.active.set(this.backends().length ? 'b0' : 'edit');
  }
}