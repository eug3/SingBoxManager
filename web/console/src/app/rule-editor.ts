import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { MonacoEditorComponent } from './monaco-editor';
import { BackendsService } from './backends.service';
import { RuleCheck, VaultService } from './vault.service';
import { PublishResp } from './models';

/** localStorage：上次选的桶 */
const BUCKET_KEY = 'vaultBucket';

/** 本地时间 HH:MM:SS（结果条上标「已发布于…」） */
function clockText(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 已发布`;
}

/**
 * 「规则编辑」主 tab — NAS 规则桶的读取 / 校验 / 格式化 / 发布。
 * 发布走 99 的 /publish（编译 .srs 后成对写回 NAS），路由约 60s 自动拉取。
 */
@Component({
  selector: 'app-rule-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MonacoEditorComponent],
  templateUrl: './rule-editor.html',
})
export class RuleEditor implements OnInit {
  private readonly vault = inject(VaultService);
  private readonly bsvc = inject(BackendsService);

  readonly buckets = this.vault.bucketLabels;
  readonly bucket = signal<string>(localStorage.getItem(BUCKET_KEY) ?? 'rs-tg');
  readonly source = signal('');
  readonly check = signal<RuleCheck>({ ok: false, msg: '未加载', detail: '' });
  readonly head = signal<{ size: string; time: string } | null>(null);
  readonly loading = signal(false);
  readonly publishing = signal(false);
  readonly result = signal<PublishResp | null>(null);
  /** 最近一次成功发布的本地时间（结果条上显示） */
  readonly publishedAt = signal('');
  /** 最近一次拉取/发布后作为「干净基线」的内容；与当前编辑器不同即视为有未发布改动 */
  private readonly baseline = signal('');
  readonly key = computed(() => this.bsvc.globalKey());
  /** 是否有未发布改动 */
  readonly dirty = computed(() => this.source() !== this.baseline());

  /** 进入即拉当前桶 */
  ngOnInit(): void {
    void this.load();
  }

  /** 拉桶源 + 预校验 + HEAD 线上 .srs 大小/时间 */
  async load(): Promise<void> {
    this.loading.set(true);
    this.result.set(null);
    try {
      const text = await this.vault.fetch(this.bucket());
      this.source.set(text);
      this.baseline.set(text);
      this.check.set(this.vault.validate(text));
      this.head.set(await this.vault.head(this.bucket()));
    } catch (e) {
      this.check.set({ ok: false, msg: '拉取失败', detail: (e as Error)?.message ?? String(e) });
    } finally {
      this.loading.set(false);
    }
  }

  /** 切换桶（记住选择）并重拉 */
  pickBucket(name: string): void {
    this.bucket.set(name);
    localStorage.setItem(BUCKET_KEY, name);
    void this.load();
  }

  /** Monaco 内容变化：即时预校验；编辑器内容变了就收回旧的发布结果，避免误读 */
  onValueChange(v: string): void {
    this.source.set(v);
    this.check.set(this.vault.validate(v));
    if (this.result()) this.result.set(null);
  }

  /** 格式化（2 空格）；语法错先提示 */
  format(): void {
    try {
      const pretty = this.vault.format(this.source());
      this.source.set(pretty);
      this.check.set(this.vault.validate(pretty));
    } catch {
      this.result.set({ ok: false, bucket: this.bucket(), json: 0, srs: 0, sha256: '', error: 'JSON 语法错误，先修好再格式化' });
    }
  }

  /** 发布：校验+密钥前置检查 → /publish → 刷新 HEAD */
  async publish(): Promise<void> {
    const c = this.check();
    if (!c.ok) {
      this.result.set({
        ok: false,
        bucket: this.bucket(),
        json: 0,
        srs: 0,
        sha256: '',
        error: '校验没通过：' + c.msg,
      });
      return;
    }
    if (!this.key()) {
      this.result.set({
        ok: false,
        bucket: this.bucket(),
        json: 0,
        srs: 0,
        sha256: '',
        error: '还没有密钥',
      });
      return;
    }
    this.publishing.set(true);
    this.result.set(null);
    try {
      const r = await this.vault.publish(this.bucket(), this.source(), this.key());
      this.result.set(r);
      if (r?.ok) {
        this.publishedAt.set(clockText());
        this.baseline.set(this.source()); // 发布成功即成为新基线
        this.head.set(await this.vault.head(this.bucket()));
      }
    } catch (e) {
      const err = e as { error?: PublishResp; status?: number; message?: string };
      const body = err?.error;
      this.result.set(
        body ?? { ok: false, bucket: this.bucket(), json: 0, srs: 0, sha256: '', error: err?.message ?? String(e) },
      );
    } finally {
      this.publishing.set(false);
    }
  }

  /** 关掉结果条 */
  dismissResult(): void {
    this.result.set(null);
  }

  /** 失败原因 → 可操作建议（按服务端常见错误分类） */
  failHint(error?: string): string {
    const e = (error || '').toLowerCase();
    if (e.includes('校验没通过')) {
      if (e.includes('json 语法错误')) return '编辑器里的 JSON 括号/逗号不完整：点「格式化」会指出位置，修好后再发布。';
      return '内容不通过前端校验（版本号、rules[] 结构或字段名）：按上面校验条的提示逐条修。';
    }
    if (e.includes('没有密钥')) return '还没有密钥：到任一后端的「配置」页填 clash 密钥，或在「⚙ 后端配置」里填密钥后再发布。';
    if (e.includes('bad key') || e.includes('401')) return '密钥不对或已轮换：到任一后端的「配置」页重填 clash 密钥后再发布。';
    if (e.includes('bad bucket')) return '桶名不合法：从下拉里选一个桶，不要手动改文件名。';
    if (e.includes('bad body') || e.includes('非法') || e.includes('invalid')) {
      return '内容被服务端拒收：多为 rules[] 结构或字段名不合法，看上面校验条的提示逐条修。';
    }
    if (e.includes('share') || e.includes('503')) return '存储通道不可用（NAS/SMB 读不到或写不进）：先在顶栏点存储状态点重测，或到「⚙ 存储配置」确认通道。';
    if (e.includes('write') || e.includes('500')) return '写回失败：服务端编译通过但写盘出错，稍后重试；持续失败看管理机 vault-edit 日志。';
    if (e.includes('failed to fetch') || e.includes('network') || e.includes('unknown error')) {
      return '请求没到达服务端（网络/服务中断）：确认入口地址可达、vault-edit 在运行，然后点「重试」。';
    }
    return '按错误原文排查；不确定时把这条错误贴给我。';
  }

  /** 字节数（结果条用简化单位） */
  fmtB(n: number | undefined): string {
    const v = n ?? 0;
    if (v < 1024) return v + 'B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'K';
    return (v / 1024 / 1024).toFixed(2) + 'M';
  }

  /** HEAD 的 Content-Length 字符串→人类可读 */
  fmtBytes(size: string | undefined): string {
    const n = Number(size);
    return Number.isFinite(n) ? this.vault.formatBytes(n) : (size ?? '?');
  }
}