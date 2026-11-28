import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CachedVersion, DeployResp, ReleaseItem, RouterVersion, VersionService } from './version.service';
import { errMsg } from './util';

/** 一条操作日志（下载 / 部署 / 删除） */
interface LogLine {
  at: string;
  kind: 'ok' | 'bad' | 'info';
  text: string;
}

/**
 * 版本管理页：99 上缓存 sing-box 各版本包，再推送到受管路由。
 *
 * 两栏结构（与共享编辑一致的视觉语言）：
 *   左：路由现状（架构 / 当前版本 / 磁盘可用 / 备份）+「部署」；
 *   右：版本库（99 上已缓存 + 官方可下载列表，按架构分别下载）。
 * 部署走 99 侧编排：上传 → 校验版本与架构 → 压缩备份 → 原子替换 → check → 重启 → 健康，
 * 失败自动回滚；结果与日志都摊在页面上，不静默。
 */
@Component({
  selector: 'app-version-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './version-pane.html',
})
export class VersionPane implements OnInit {
  private readonly svc = inject(VersionService);

  readonly loading = signal(true);
  readonly loadErr = signal('');
  readonly routers = signal<RouterVersion[]>([]);
  readonly local = signal<CachedVersion[]>([]);
  readonly releases = signal<ReleaseItem[]>([]);
  readonly cacheDir = signal('');
  readonly freeMB = signal(0);
  readonly mirrors = signal<string[]>([]);
  readonly releaseWarn = signal('');

  /** 正在下载的 `${version}|${arch}`；空 = 空闲 */
  readonly downloading = signal('');
  /** 正在部署的路由 host */
  readonly deploying = signal('');
  readonly deployResult = signal<DeployResp | null>(null);
  readonly log = signal<LogLine[]>([]);
  /** 版本列表搜索词 */
  readonly query = signal('');
  /** 只显示「有缓存」或「最新若干」 */
  readonly onlyCached = signal(false);

  /** 部署弹窗：对哪台路由开着 */
  readonly deployFor = signal<RouterVersion | null>(null);
  readonly deployVersion = signal('');
  readonly deployErr = signal('');

  /** 已缓存的「版本|架构」集合，模板里快速判断 */
  readonly cachedKeys = computed(() => {
    const m = new Map<string, CachedVersion>();
    for (const c of this.local()) m.set(`${c.version}|${c.arch}`, c);
    return m;
  });

  /**
   * 路由 libc 决定该下哪个变体（实测：默认包是 glibc 动态链接，推到 OpenWrt/GL.iNet 会 not found）。
   * 同一架构下只要有一台是 musl 就按 musl 推荐。
   */
  recommendedVariant(arch: string): string {
    const rs = this.routers().filter((r) => r.arch === arch);
    if (rs.some((r) => r.libc === 'musl')) return 'musl';
    if (rs.some((r) => r.libc === 'glibc')) return 'glibc';
    return '';
  }

  /** 需要下载的目标：架构 + 推荐变体（去重，按架构排序） */
  readonly targets = computed(() => {
    const m = new Map<string, { arch: string; variant: string }>();
    for (const r of this.routers()) {
      if (!r.arch) continue;
      if (!m.has(r.arch)) m.set(r.arch, { arch: r.arch, variant: this.recommendedVariant(r.arch) });
    }
    return [...m.values()].sort((a, b) => a.arch.localeCompare(b.arch));
  });

  /** 某架构 + 变体下已缓存的版本（部署下拉用） */
  cachedForArch(arch: string, variant?: string): CachedVersion[] {
    const v = variant === undefined ? this.recommendedVariant(arch) : variant;
    return this.local().filter((c) => c.arch === arch && c.variant === v);
  }

  /** 变体短标签 */
  variantOf(v: string): string {
    return v === '' ? '默认' : v;
  }

  /** 过滤后的版本列表 */
  readonly releaseRows = computed(() => {
    const q = this.query().trim().toLowerCase();
    let rows = this.releases();
    if (q) rows = rows.filter((r) => r.version.toLowerCase().includes(q));
    if (this.onlyCached()) rows = rows.filter((r) => this.cachedArches(r.version).length > 0);
    return rows;
  });

  /** 某个版本已缓存的架构列表 */
  cachedArches(version: string): string[] {
    return this.local().filter((c) => c.version === version).map((c) => c.arch);
  }

  /** 某版本 + 架构 + 变体是否已缓存 */
  hasPkg(version: string, arch: string, variant: string): boolean {
    return this.local().some((c) => c.version === version && c.arch === arch && c.variant === variant);
  }

  /** 两台路由需要哪些架构（下载按钮只列这些，避免下一堆没用的） */
  readonly neededArches = computed(() => {
    const s = new Set<string>();
    for (const r of this.routers()) if (r.arch) s.add(r.arch);
    return [...s].sort();
  });

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.loadErr.set('');
    try {
      const d = await this.svc.list();
      this.routers.set(d.routers ?? []);
      this.local.set(d.local ?? []);
      this.cacheDir.set(d.cacheDir ?? '');
      this.freeMB.set(d.disk?.freeMB ?? 0);
      this.mirrors.set(d.mirrors ?? []);
    } catch (e) {
      this.loadErr.set(errMsg(e));
    } finally {
      this.loading.set(false);
    }
    void this.loadReleases();
  }

  async loadReleases(force = false): Promise<void> {
    try {
      const d = await this.svc.available(force);
      this.releases.set(d.releases ?? []);
      this.releaseWarn.set(d.warning ?? '');
    } catch (e) {
      this.releaseWarn.set(errMsg(e));
    }
  }

  /** 下载一个「版本 + 架构」到 99 */
  async download(version: string, arch: string, variant: string): Promise<void> {
    if (this.downloading()) return;
    const key = `${version}|${arch}|${variant}`;
    this.downloading.set(key);
    this.push('info', `开始下载 ${version} / ${arch}-${this.variantOf(variant)}…`);
    try {
      const r = await this.svc.download(version, arch, variant);
      if (r.cached) {
        this.push('info', `${version} / ${arch}-${this.variantOf(variant)} 已在 99 缓存`);
      } else {
        const mb = r.size ? (r.size / 1048576).toFixed(1) : '?';
        this.push(
          'ok',
          `${version} / ${arch}-${this.variantOf(variant)} 下载完成：${mb} MB，用时 ${(r.secs ?? 0).toFixed(1)}s（${r.source ?? '直连'}）`,
        );
      }
      await this.refresh();
    } catch (e) {
      this.push('bad', `${version} / ${arch}-${this.variantOf(variant)} 下载失败：${errMsg(e)}`);
    } finally {
      this.downloading.set('');
    }
  }

  /** 删除 99 上的一个缓存包 */
  async remove(version: string, arch: string, variant: string): Promise<void> {
    try {
      await this.svc.remove(version, arch, variant);
      this.push('info', `已从 99 删除 ${version} / ${arch}-${this.variantOf(variant)}`);
      await this.refresh();
    } catch (e) {
      this.push('bad', `删除失败：${errMsg(e)}`);
    }
  }

  /** 打开部署弹窗（默认选最新且架构匹配的缓存版本） */
  openDeploy(r: RouterVersion): void {
    this.deployFor.set(r);
    this.deployErr.set('');
    const cand = this.cachedForArch(r.arch, this.variantFor(r));
    this.deployVersion.set(cand.length ? cand[0].version : '');
  }

  /** 这台路由该用的变体（按它自己的 libc） */
  variantFor(r: RouterVersion): string {
    if (r.libc === 'musl') return 'musl';
    if (r.libc === 'glibc') return 'glibc';
    return this.recommendedVariant(r.arch);
  }

  /** 某台路由可部署的缓存包 */
  deployCandidates(r: RouterVersion): CachedVersion[] {
    return this.cachedForArch(r.arch, this.variantFor(r));
  }

  /** 确认部署 */
  async doDeploy(): Promise<void> {
    const r = this.deployFor();
    const v = this.deployVersion();
    if (!r || !v) return;
    this.deployErr.set('');
    this.deploying.set(r.host);
    this.deployFor.set(null);
    this.deployResult.set(null);
    this.push('info', `开始部署 ${v} → ${r.name || r.host}（${r.arch}）…`);
    try {
      const res = await this.svc.deploy(r.host, v, r.arch, this.variantFor(r));
      this.deployResult.set(res);
      if (res.ok) {
        this.push(
          'ok',
          `部署成功：${r.name || r.host} ${res.before || '?'} → ${res.after || v}（上传 ${(res.uploadSecs ?? 0).toFixed(1)}s，总 ${(res.secs ?? 0).toFixed(1)}s）`,
        );
      } else {
        this.push('bad', `部署未成功：${res.error ?? '未知原因'}`);
      }
      await this.refresh();
    } catch (e) {
      // 失败时后端也会回结构化结果（含「已回滚」），能拿到就展示
      const body = (e as { error?: { error?: string } })?.error;
      this.deployResult.set((body as unknown as DeployResp) ?? null);
      this.push('bad', `部署失败：${body?.error ?? errMsg(e)}`);
      await this.refresh();
    } finally {
      this.deploying.set('');
    }
  }

  push(kind: LogLine['kind'], text: string): void {
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.log.update((l) => [{ at, kind, text }, ...l].slice(0, 40));
  }

  /** 路由是否已是某版本 */
  isCurrent(r: RouterVersion, version: string): boolean {
    return r.version === version;
  }

  mbOf(n?: number): string {
    if (!n) return '—';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  atOf(s?: string): string {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false });
  }
}