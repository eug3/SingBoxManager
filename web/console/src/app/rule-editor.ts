import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { MonacoEditorComponent } from './monaco-editor';
import { BackendsService } from './backends.service';
import { RuleCheck, VaultService } from './vault.service';
import type { BucketInfo } from './vault.service';
import { PublishResp } from './models';
import { ConfirmService } from './confirm.service';
import { fmtBytes } from './util';

/** localStorage：上次选的桶 */
const BUCKET_KEY = 'vaultBucket';

/** 桶名规则（与服务端 bucketRe 同口径）：rs-小写字母/数字/- 或 bard-domains */
const BUCKET_RE = /^(rs-[a-z0-9-]+|bard-domains)$/;

/** 文件树里的一行：桶名 + 右侧元信息（.srs 大小/时间） */
interface BucketOption {
  name: string;
  meta: string;
}

/** 本地时间 MM-DD HH:mm（桶的 .srs 更新时间） */
function timeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 服务端清单 → 文件树行（meta = .json 大小 · 更新时间；只列有 .json 的桶，编译产物 .srs 不上树） */
function optionFromInfo(b: BucketInfo): BucketOption {
  const bits: string[] = [];
  if (b.jsonSize) bits.push(fmtBytes(b.jsonSize));
  if (b.jsonTime) bits.push(timeShort(b.jsonTime));
  return { name: b.name, meta: bits.join(' · ') };
}

/** 桶是否在树里：必须有 .json 源（只有 .srs 的编译产物不显示） */
function hasJsonSource(b: BucketInfo): boolean {
  return b.jsonSize !== undefined || b.jsonTime !== undefined;
}

/** HTTP 错误 → 可读文案（服务端 fail() 形如 {error: "..."}） */
function httpErr(e: unknown): string {
  const x = e as { error?: { error?: string; message?: string }; message?: string };
  return x?.error?.error || x?.error?.message || x?.message || String(e);
}

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
  /** 页内确认框（切换文件丢弃改动 / 删除桶） */
  private readonly ui = inject(ConfirmService);

  /** 文件树：唯一来源是服务端 /rule-set/index（NAS 目录实时列） */
  readonly buckets = signal<BucketOption[]>([]);
  /** 清单来源：nas=服务端实时列目录；error=接口没取到（树为空，模板提示原因） */
  readonly bucketSource = signal<'nas' | 'error'>('error');
  readonly bucket = signal<string>(localStorage.getItem(BUCKET_KEY) ?? 'rs-tg');
  /** 根节点折叠（文件多时可收起） */
  readonly folded = signal(false);
  /** 新建桶：表单开关、输入名、进行中、错误文案 */
  readonly creating = signal(false);
  readonly newName = signal('');
  /** 右键菜单：位置 + 目标（blank=树空白/根节点，file=某个桶） */
  readonly menu = signal<{ x: number; y: number; target: 'blank' | 'file'; name: string } | null>(null);
  /** 重命名表单：源桶名 + 输入值 */
  readonly renaming = signal<string | null>(null);
  readonly renameName = signal('');
  readonly acting = signal(false);
  readonly opErr = signal('');
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

  /** 进入：先拉桶清单（服务端实时列目录），再拉当前桶内容 */
  ngOnInit(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    await this.initBuckets();
    void this.load();
  }

  /**
   * 桶清单来自 /rule-set/index（服务端直接列 NAS 目录），新增/删除桶自动反映；
   * 拉不到（旧版服务、NAS 抖动）就保留内置清单，页面照常可用。
   */
  private async initBuckets(): Promise<void> {
    try {
      const list = await this.vault.listBuckets();
      // 只列有 .json 源的桶：只有 .srs 的编译产物不进树（没有可编辑的源文件）
      const source = list.filter(hasJsonSource);
      this.buckets.set(source.map(optionFromInfo));
      this.bucketSource.set('nas');
      // 上次选的桶可能已被删除（如 rs-node*）：退到第一个，别带着 404 的名字进页面
      if (source.length && !source.some((b) => b.name === this.bucket())) this.applyBucket(source[0].name);
    } catch {
      /* 服务不可用：保留空清单，模板里提示 /rule-set/index 未响应 */
    }
  }

  /** 只改选中并记住（不重拉，初始化用） */
  private applyBucket(name: string): void {
    this.bucket.set(name);
    localStorage.setItem(BUCKET_KEY, name);
  }

  /** 点文件树：有未发布改动先确认；确认后切换并重拉 */
  async openBucket(name: string): Promise<void> {
    if (name === this.bucket()) return;
    if (this.dirty()) {
      const ok = await this.ui.ask({
        title: `当前桶 ${this.bucket()} 有未发布改动`,
        body: '切换文件会丢弃这些改动（还没发布到 NAS）。',
        okText: '丢弃并切换',
        danger: true,
      });
      if (!ok) return;
    }
    this.opErr.set('');
    this.applyBucket(name);
    void this.load();
  }

  /* ── 新建 / 删除桶（写 NAS，页面同源放行；脚本调用需 X-Vault-Key） ── */

  /** 打开新建表单 */
  startCreate(): void {
    this.creating.set(true);
    this.newName.set('');
    this.opErr.set('');
  }

  /** 取消新建 */
  cancelCreate(): void {
    this.creating.set(false);
    this.newName.set('');
  }

  /** 新建空桶（只写 .json；rules 空，填好规则后再点「保存并发布」生成 .srs） */
  async createBucket(): Promise<void> {
    const name = this.newName().trim();
    if (!BUCKET_RE.test(name)) {
      this.opErr.set('桶名只能是 rs-小写字母/数字/短横线，或 bard-domains');
      return;
    }
    if (this.buckets().some((b) => b.name === name)) {
      this.opErr.set('同名桶已存在：' + name);
      return;
    }
    this.acting.set(true);
    this.opErr.set('');
    try {
      await this.vault.createBucket(name, this.key());
      this.creating.set(false);
      await this.initBuckets();
      this.applyBucket(name);
      void this.load();
    } catch (e) {
      this.opErr.set('新建失败：' + httpErr(e));
    } finally {
      this.acting.set(false);
    }
  }

  /**
   * 删除指定桶（.json + .srs 一起删，需确认）。
   * 入口只有文件行右键菜单；删的不是当前文件时只刷新树，不动编辑器。
   */
  async deleteBucket(name: string): Promise<void> {
    if (!name) return;
    const ok = await this.ui.ask({
      title: `删除桶 ${name}.json？`,
      body: '会同时删除 .json 与 .srs，不可恢复；若还有路由 config 引用它，路由会拉取失败并在日志报错。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    this.acting.set(true);
    this.opErr.set('');
    try {
      await this.vault.deleteBucket(name, this.key());
      const wasCurrent = this.bucket() === name;
      await this.initBuckets();
      if (!wasCurrent) return;
      const rest = this.buckets();
      if (rest.length) {
        this.applyBucket(rest[0].name);
        void this.load();
      } else {
        this.bucket.set('');
        this.source.set('');
        this.baseline.set('');
        this.check.set({ ok: false, msg: '没有桶', detail: '' });
        this.head.set(null);
        this.result.set(null);
      }
    } catch (e) {
      this.opErr.set('删除失败：' + httpErr(e));
    } finally {
      this.acting.set(false);
    }
  }

  /* ── 右键菜单：空白=新建；文件=重命名/删除 ── */

  /** 目录树右键：记录位置与目标（空白/根节点头 = blank） */
  onTreeContext(ev: MouseEvent, name = ''): void {
    ev.preventDefault();
    ev.stopPropagation();
    const x = Math.max(4, Math.min(ev.clientX, innerWidth - 152));
    const y = Math.max(4, Math.min(ev.clientY, innerHeight - 96));
    this.menu.set({ x, y, target: name ? 'file' : 'blank', name });
  }

  /** 关掉右键菜单 */
  closeMenu(): void {
    this.menu.set(null);
  }

  /** 打开重命名表单（预填旧名，同侧栏顶部的小输入行） */
  startRename(name: string): void {
    this.renaming.set(name);
    this.renameName.set(name);
    this.creating.set(false);
    this.opErr.set('');
  }

  /** 取消重命名 */
  cancelRename(): void {
    this.renaming.set(null);
  }

  /** 重命名桶：.json 与 .srs 一起搬；当前正在编辑它时切到新名并重拉 */
  async renameBucket(): Promise<void> {
    const from = this.renaming();
    const to = this.renameName().trim();
    if (!from) return;
    if (to === from) {
      this.cancelRename();
      return;
    }
    if (!BUCKET_RE.test(to)) {
      this.opErr.set('桶名只能是 rs-小写字母/数字/短横线，或 bard-domains');
      return;
    }
    if (this.buckets().some((b) => b.name === to)) {
      this.opErr.set('同名桶已存在：' + to);
      return;
    }
    const ok = await this.ui.ask({
      title: `把 ${from}.json 重命名为 ${to}.json？`,
      body: '会同时搬 .srs；若路由 config 里仍引用旧 tag，路由会拉取失败，需要同步改 config。',
      okText: '重命名',
      danger: true,
    });
    if (!ok) return;
    this.acting.set(true);
    this.opErr.set('');
    try {
      await this.vault.renameBucket(from, to, this.key());
      this.renaming.set(null);
      const wasCurrent = this.bucket() === from;
      await this.initBuckets();
      if (wasCurrent) {
        this.applyBucket(to);
        void this.load();
      }
    } catch (e) {
      this.opErr.set('重命名失败：' + httpErr(e));
    } finally {
      this.acting.set(false);
    }
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

  /**
   * 发布：校验 → /publish → 刷新 HEAD。
   * 规则桶的写权限与路由无关（只动 NAS 上的文件）：页面同源调用由服务端按 Origin 放行，
   * 不需要任何手填密钥；密钥仅留给脚本/无浏览器场景。
   */
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
    this.publishing.set(true);
    this.result.set(null);
    // 空桶（rules 为空）只适合存在 .json，服务端无法编译 .srs：先拦下来给明确提示
    let rulesCount = 0;
    try {
      const doc = JSON.parse(this.source()) as { rules?: unknown[] };
      rulesCount = Array.isArray(doc.rules) ? doc.rules.length : 0;
    } catch {
      /* 语法错已被上面的校验拦掉 */
    }
    if (!rulesCount) {
      this.publishing.set(false);
      this.result.set({
        ok: false,
        bucket: this.bucket(),
        json: 0,
        srs: 0,
        sha256: '',
        error: 'rules 为空：空桶不生成 .srs，先加规则再发布',
      });
      return;
    }
    try {
      const r = await this.vault.publish(this.bucket(), this.source(), this.key());
      this.result.set(r);
      if (r?.ok) {
        this.publishedAt.set(clockText());
        this.baseline.set(this.source()); // 发布成功即成为新基线
        this.head.set(await this.vault.head(this.bucket()));
        void this.initBuckets(); // 文件树的大小/时间跟着刷新
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
    if (e.includes('没有密钥')) return '页面同源发布不需要密钥；若从脚本调用，需要在请求头带 X-Vault-Key。';
    if (e.includes('rules 为空') || e.includes('rules[] required')) {
      return '空桶只保存 .json，不会生成 .srs：先在编辑器里加至少一条规则，再点发布。';
    }
    if (e.includes('bad key') || e.includes('401')) return '服务端拒绝了这次发布请求：从管理台页面重试通常即可（同源放行）；脚本调用请核对 X-Vault-Key。';
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