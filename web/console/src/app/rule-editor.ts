import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { MonacoEditorComponent } from './monaco-editor';
import { BackendsService } from './backends.service';
import { RuleCheck, VaultService } from './vault.service';
import { PublishResp } from './models';

const BUCKET_KEY = 'vaultBucket';

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
  readonly key = computed(() => this.bsvc.globalKey());

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.result.set(null);
    try {
      const text = await this.vault.fetch(this.bucket());
      this.source.set(text);
      this.check.set(this.vault.validate(text));
      this.head.set(await this.vault.head(this.bucket()));
    } catch (e) {
      this.check.set({ ok: false, msg: '拉取失败', detail: (e as Error)?.message ?? String(e) });
    } finally {
      this.loading.set(false);
    }
  }

  pickBucket(name: string): void {
    this.bucket.set(name);
    localStorage.setItem(BUCKET_KEY, name);
    void this.load();
  }

  onValueChange(v: string): void {
    this.source.set(v);
    this.check.set(this.vault.validate(v));
  }

  format(): void {
    try {
      const pretty = this.vault.format(this.source());
      this.source.set(pretty);
      this.check.set(this.vault.validate(pretty));
    } catch {
      alert('JSON 语法错误，先修好再格式化');
    }
  }

  async publish(): Promise<void> {
    const c = this.check();
    if (!c.ok) return alert('校验没通过：' + c.msg);
    if (!this.key()) return alert('先在右上角填「发布密钥」（= 99 的 VAULT_KEY）');
    this.publishing.set(true);
    this.result.set(null);
    try {
      const r = await this.vault.publish(this.bucket(), this.source(), this.key());
      this.result.set(r);
      if (r?.ok) this.head.set(await this.vault.head(this.bucket()));
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

  fmtBytes(size: string | undefined): string {
    const n = Number(size);
    return Number.isFinite(n) ? this.vault.formatBytes(n) : (size ?? '?');
  }
}