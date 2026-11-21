import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { Backend, CONSOLE_VERSION, PAGE_ORIGINS } from './models';
import { RouterStatusService } from './status.service';

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
  private readonly rstatus = inject(RouterStatusService);
  readonly version = CONSOLE_VERSION;
  /** 底部信息条：当前生效后端的 sing-box 版本 */
  readonly sbVersion = signal('');
  readonly backends = this.bsvc.backends;
  readonly active = signal<string>(this.backends().length ? 'b0' : 'edit');
  readonly originOk = PAGE_ORIGINS.includes(location.origin);
  readonly origins = PAGE_ORIGINS;

  /** 当前激活后端下标（顶栏状态点用）；规则编辑页为 -1 */
  readonly activeIndex = computed(() => {
    const m = /^b(\d+)$/.exec(this.active());
    return m ? Number(m[1]) : -1;
  });

  /** 当前激活后端的配置通道状态（配置页读过才有） */
  readonly activeStatus = computed(() => {
    const i = this.activeIndex();
    const b = i >= 0 ? this.backends()[i] : undefined;
    if (!b) return null;
    const host = this.hostOf(b);
    return this.rstatus.statuses()[host] ?? null;
  });

  /** 顶栏状态点文案 */
  readonly statusText = computed(() => {
    const s = this.activeStatus();
    if (!s) return '配置通道 · 未检测';
    if (!s.ok) return '配置通道 · 未连接';
    return `配置通道 · 已连接 ${s.size ?? 0}B · ${s.nodes ?? 0} 节点`;
  });

  /** 点击状态点：打开该后端的「配置」子页 */
  openConfig(): void {
    const i = this.activeIndex();
    if (i >= 0) this.rstatus.requestConfigTab(i);
  }

  private hostOf(b: Backend): string {
    try {
      return new URL(b.api).hostname;
    } catch {
      return b.api;
    }
  }

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