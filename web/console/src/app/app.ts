import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { Backend, CONSOLE_VERSION, PAGE_ORIGINS } from './models';
import { ShareHealthService } from './share-health.service';

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
  private readonly shareHealth = inject(ShareHealthService);
  readonly version = CONSOLE_VERSION;
  /** 底部信息条：当前生效后端的 sing-box 版本 */
  readonly sbVersion = signal('');
  readonly backends = this.bsvc.backends;
  readonly active = signal<string>(this.backends().length ? 'b0' : 'edit');
  readonly originOk = PAGE_ORIGINS.includes(location.origin);
  readonly origins = PAGE_ORIGINS;

  /** 文件通道 + 公网 URL 体检结果（顶栏右侧那个点） */
  readonly share = this.shareHealth.health;
  readonly shareBusy = this.shareHealth.busy;

  /** 顶栏状态点文案：SMB/SFTP 文件通道 + 公网 HTTP 读取是否都通 */
  readonly statusText = computed(() => {
    const h = this.share();
    if (!h) return '存储 · 检测中…';
    const mode = h.file.mode.startsWith('smb') ? 'SMB' : h.file.mode.startsWith('sftp') ? 'SFTP' : '本地';
    const file = h.file.ok ? `${mode} ✓ ${h.file.files} 文件` : `${mode} ✗`;
    const http = h.http.ok ? `HTTP ${h.http.status}` : h.http.status ? `HTTP ${h.http.status}` : 'HTTP ✗';
    return `存储 · ${file} · ${http}`;
  });

  /** 悬停提示：把体检细节摊开 */
  readonly statusTitle = computed(() => {
    const h = this.share();
    if (!h) return '正在检查文件通道与公网 URL…';
    const f = h.file;
    const x = h.http;
    return [
      `文件通道：${f.mode}`,
      f.ok ? `  ✓ ${f.detail}（${f.ms}ms）` : `  ✗ ${f.error ?? '不可用'}`,
      `公网 URL：${x.url}`,
      x.ok ? `  ✓ ${x.status} · ${x.size}B（${x.ms}ms）` : `  ✗ ${x.error ?? '状态 ' + x.status}`,
      '点击重新检测',
    ].join('\n');
  });

  /** 点击状态点：立即重测 */
  probeShare(): void {
    void this.shareHealth.probe();
  }

  constructor() {
    this.shareHealth.start(); // 每 30s 体检一次文件通道 + 公网 URL
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