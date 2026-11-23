import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ShareHealthService, PublicRulesApplyHost, PublicRulesPreviewHost, ShareConfigPayload, ShareProbe } from './share-health.service';
import { ConfirmService } from './confirm.service';

/**
 * 存储配置弹窗（顶栏状态点后面的小齿轮）——
 * 编辑「规则桶文件在哪、公网入口是什么」，保存后服务端热生效，不需要重启。
 *
 * 三种模式：
 *   smb    纯 Go SMB2 直连 NAS（默认）
 *   sftp   纯 Go SFTP（NAS 只开 SSH 时）
 *   local  文件就在 99 本机目录，完全不依赖 SMB/SFTP（公网入口要另配）
 */
@Component({
  selector: 'app-share-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './share-config.html',
})
export class ShareConfigDialog {
  readonly closed = output<{ changed: boolean }>();

  private readonly svc = inject(ShareHealthService);
  /** 页内确认框（取代原生 confirm） */
  private readonly ui = inject(ConfirmService);

  readonly busy = signal(false);
  readonly err = signal('');
  readonly note = signal('');
  readonly probeResult = signal<ShareProbe | null>(null);
  /** 公网入口 → 路由器规则的预览 / 写入结果 */
  readonly rulesPreview = signal<PublicRulesPreviewHost[] | null>(null);
  readonly rulesApplied = signal<PublicRulesApplyHost[] | null>(null);

  // 表单（结构化，直接双向绑定）
  readonly form = signal<ShareConfigPayload>({
    mode: 'smb',
    smb: { addr: '192.168.31.8:445', share: 'HddShare', path: 'WebEdit/rule-set', user: '', pass: '', domain: '' },
    sftp: { addr: '', user: '', pass: '', key: '', path: '/volume1/WebEdit/rule-set' },
    local: { dir: '/usr/local/share/vault-edit/rule-set' },
    publicBase: '',
    filesListen: ':9098',
    sample: 'rs-tg.srs',
  });
  readonly passSet = signal<{ smb: boolean; sftp: boolean }>({ smb: false, sftp: false });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.busy.set(true);
    try {
      const cfg = await this.svc.configGet();
      this.form.set({
        mode: cfg.mode,
        smb: { ...cfg.smb, pass: '' },
        sftp: { ...cfg.sftp, pass: '' },
        local: { ...cfg.local },
        publicBase: cfg.publicBase,
        filesListen: cfg.filesListen,
        sample: cfg.sample,
      });
      this.passSet.set({ smb: cfg.smb.passSet, sftp: cfg.sftp.passSet });
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 按 'a.b' 路径更新表单字段（结构化浅拷贝，避免整表重渲染丢焦点） */
  patch(path: string, value: unknown): void {
    this.form.update((f) => {
      const parts = path.split('.');
      if (parts.length === 1) {
        return { ...f, [parts[0]]: value } as ShareConfigPayload;
      }
      const [group, key] = parts;
      const bucket = { ...(f as unknown as Record<string, Record<string, unknown>>)[group] };
      bucket[key] = value;
      return { ...f, [group]: bucket } as ShareConfigPayload;
    });
  }

  /** 测试（不保存） */
  async probe(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    this.probeResult.set(null);
    try {
      this.probeResult.set(await this.svc.probeWith(this.form()));
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 把当前共享的桶文件复制到本机 local 目录（切 local 之前跑一次） */
  async importLocal(): Promise<void> {
    const ok = await this.ui.ask({
      title: '把当前共享里的桶文件复制到本机目录？',
      body: '已存在的同名文件会被覆盖。',
      okText: '开始复制',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    this.err.set('');
    try {
      const r = await this.svc.importToLocal();
      this.note.set(`已复制 ${r.copied} 个文件到 ${r.dir}（跳过 ${r.skipped} 个非桶文件）`);
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 预览：按当前填的公网入口，两台路由各会改多少条 rule_set url */
  async previewRules(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    this.rulesApplied.set(null);
    try {
      const r = await this.svc.publicRulesPreview(this.form().publicBase);
      this.rulesPreview.set(r.hosts);
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 写入路由器规则（会重启 sing-box，断流约 1s） */
  async applyRules(): Promise<void> {
    const hosts = this.rulesPreview() ?? [];
    const total = hosts.reduce((n, h) => n + (h.changes ?? 0), 0);
    if (!total) {
      this.err.set('没有需要改写的 url（先用「预览改写」确认）');
      return;
    }
    const ok = await this.ui.ask({
      title: `把 ${hosts.length} 台路由的 rule_set url 改到 ${this.form().publicBase}？`,
      body: `共 ${total} 条，会重启 sing-box，约 1 秒断流，失败自动回滚。`,
      okText: '改写并重启',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    this.err.set('');
    try {
      const r = await this.svc.publicRulesApply(this.form().publicBase);
      this.rulesApplied.set(r.hosts);
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 保存并立即生效 */
  async save(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    try {
      const r = await this.svc.configSave(this.form());
      this.note.set(r.fileOK ? `已保存并生效：${r.mode} · ${r.files} 个文件可用` : `已保存，但连通性失败：${r.fileError}`);
      this.closed.emit({ changed: true });
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    this.closed.emit({ changed: false });
  }
}