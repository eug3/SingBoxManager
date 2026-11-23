/**
 * app 根壳 —— 控制台的固定外壳（100dvh，滚动只发生在各面板内部，见 styles.css）。
 * 结构自上而下：
 *  - 顶栏：标题 + 存储状态点（SMB/SFTP 文件通道 + 公网 URL 体检，点击重测）+ ⚙ 存储配置齿轮；
 *  - 来源受信横幅：页面来源不在白名单时提示换入口；
 *  - 主 tab：各后端面板（草稿带 ✎ 标记）/ ＋添加后端 / 规则编辑；
 *  - 页脚：控制台版本、当前生效后端的 sing-box 版本、发布链路与入口信息。
 * 密钥不在顶栏填写：统一走「配置」页的连接门禁或各后端「⚙ 后端配置」。
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { Backend, CONSOLE_VERSION, PAGE_ORIGINS } from './models';
import type { PaneTab } from './backend-pane';
import { ShareHealthService } from './share-health.service';
import { ShareConfigDialog } from './share-config';
import { ConfirmDialog } from './confirm-dialog';
import { Toast } from './toast';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackendPane, RuleEditor, ShareConfigDialog, ConfirmDialog, Toast],
  templateUrl: './app.html',
})
/** 根组件：组装顶栏 / 主 tab / 内容区 / 页脚，并驱动存储体检与 sing-box 版本探测 */
export class App {
  /** 后端列表服务：后端增删改、全局密钥与有效性判断 */
  readonly bsvc = inject(BackendsService);
  /** clash_api 客户端：这里只用于探测 sing-box 版本 */
  private readonly clash = inject(ClashService);
  /** 存储体检服务：周期性探测文件通道与公网 URL */
  private readonly shareHealth = inject(ShareHealthService);
  /** 页脚展示的控制台版本号 */
  readonly version = CONSOLE_VERSION;
  /** 底部信息条：当前生效后端的 sing-box 版本 */
  readonly sbVersion = signal('');
  /** 全部后端（含未保存草稿）：主 tab 与内容区据此渲染 */
  readonly backends = this.bsvc.backends;
  /** 当前主 tab：'b'+序号 = 第 n 个后端面板，'edit' = 规则编辑；没有后端时落在规则编辑 */
  readonly active = signal<string>(this.backends().length ? 'b0' : 'edit');
  /** 当前激活后端的下标（active 不是 'b<n>' 时为 null，即停在规则编辑） */
  readonly activeIndex = computed<number | null>(() => {
    const m = /^b(\d+)$/.exec(this.active());
    const i = m ? Number(m[1]) : -1;
    return i >= 0 && i < this.backends().length ? i : null;
  });
  /** 每个后端各自记住的子页（切走再切回来不跳回「概览」；按后端下标存，刷新页面后回默认概览） */
  private readonly panes = signal<Record<number, PaneTab>>({});
  /** 某后端当前应落在的子页 */
  paneOf(i: number): PaneTab {
    return this.panes()[i] ?? 'overview';
  }
  /** 记录某后端切到了哪个子页 */
  onPaneChange(i: number, t: PaneTab): void {
    this.panes.update((m) => ({ ...m, [i]: t }));
  }
  /** 当前页面来源是否受信（不受信时模板显示横幅提示） */
  readonly originOk = PAGE_ORIGINS.includes(location.origin);
  /** 受信来源清单（横幅文案用） */
  readonly origins = PAGE_ORIGINS;

  /** 文件通道 + 公网 URL 体检结果（顶栏右侧那个点） */
  readonly share = this.shareHealth.health;
  /** 齿轮弹窗开关 */
  readonly shareCfgOpen = signal(false);

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

  /** 齿轮：打开存储配置弹窗 */
  openShareConfig(e: Event): void {
    e.stopPropagation(); // 别触发状态点的重测
    this.shareCfgOpen.set(true);
  }

  /** 弹窗关闭：改了配置就立刻重新体检 */
  onShareCfgClosed(ev: { changed: boolean }): void {
    this.shareCfgOpen.set(false);
    if (ev.changed) void this.shareHealth.probe();
  }

  constructor() {
    this.shareHealth.start(); // 每 30s 体检一次文件通道 + 公网 URL
    // 生效后端变化时重新探测 sing-box 版本（供页脚展示）
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

  /** 「＋ 添加后端」：新建一个草稿后端并立即切到它的 tab */
  addBackend(): void {
    const i = this.bsvc.addDraft();
    this.active.set('b' + i);
  }

  /** 某后端面板被删除后回到第一个后端；没有后端时落在规则编辑 */
  onRemoved(): void {
    this.active.set(this.backends().length ? 'b0' : 'edit');
  }
}