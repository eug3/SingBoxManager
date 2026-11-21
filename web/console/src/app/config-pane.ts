import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Backend } from './models';
import { RouterService } from './router.service';
import { BackendsService } from './backends.service';
import { MonacoEditorComponent } from './monaco-editor';

interface NodeRow {
  tag: string;
  type: string;
  server: string;
  credential: string;
  groups: string[];
  routeRefs: number;
  special: boolean;
}

interface DiffLine {
  kind: 'add' | 'del';
  text: string;
}

const SPECIAL_TYPES = new Set(['direct', 'block', 'dns']);
const GROUP_TYPES = new Set(['selector', 'urltest']);

/** 「配置」子页：读/校验/应用/重启 sing-box 配置（经 99 受限 SSH → 路由器单脚本） */
@Component({
  selector: 'app-config-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MonacoEditorComponent],
  templateUrl: './config-pane.html',
})
export class ConfigPane {
  readonly backend = input.required<Backend>();

  private readonly router = inject(RouterService);
  private readonly bsvc = inject(BackendsService);

  readonly host = computed(() => this.router.host(this.backend()));
  readonly raw = signal('');
  readonly original = signal('');
  readonly sha = signal('');
  readonly size = signal(0);
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly err = signal('');
  readonly log = signal('');
  readonly loaded = signal(false);

  constructor() {
    effect(() => {
      const b = this.backend();
      // 读/写路由配置只需要发布密钥（X-Vault-Key），与后端 clash secret 无关
      const vaultKey = this.bsvc.globalKey();
      if (!b.api || !vaultKey) return;
      void this.reload();
    });
  }

  readonly parsed = computed<Record<string, unknown> | null>(() => {
    try {
      const v = JSON.parse(this.raw()) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });

  readonly jsonError = computed(() => {
    if (!this.raw().trim()) return '';
    try {
      JSON.parse(this.raw());
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  });

  /** 节点（outbounds 里的代理节点 + endpoints） */
  readonly nodes = computed<NodeRow[]>(() => {
    const cfg = this.parsed();
    if (!cfg) return [];
    const outbounds = Array.isArray(cfg['outbounds']) ? (cfg['outbounds'] as Record<string, unknown>[]) : [];
    const endpoints = Array.isArray(cfg['endpoints']) ? (cfg['endpoints'] as Record<string, unknown>[]) : [];
    const groups = outbounds.filter((o) => GROUP_TYPES.has(String(o['type'])));
    const routeRefs = new Map<string, number>();
    const route = cfg['route'] as Record<string, unknown> | undefined;
    const rules = Array.isArray(route?.['rules']) ? (route!['rules'] as Record<string, unknown>[]) : [];
    for (const r of rules) {
      const ref = r['outbound'];
      if (typeof ref === 'string') routeRefs.set(ref, (routeRefs.get(ref) ?? 0) + 1);
    }
    const rows: NodeRow[] = [];
    for (const o of [...outbounds, ...endpoints]) {
      const type = String(o['type'] ?? '?');
      if (GROUP_TYPES.has(type)) continue;
      const tag = String(o['tag'] ?? '?');
      const inGroups = groups
        .filter((g) => Array.isArray(g['outbounds']) && (g['outbounds'] as string[]).includes(tag))
        .map((g) => String(g['tag']));
      const host = o['server'] ?? o['server_name'] ?? o['host'] ?? '';
      const port = o['server_port'] ?? o['port'] ?? '';
      rows.push({
        tag,
        type,
        server: host ? `${host}${port ? ':' + port : ''}` : '—',
        credential: this.maskCredential(o),
        groups: inGroups,
        routeRefs: routeRefs.get(tag) ?? 0,
        special: SPECIAL_TYPES.has(type) || SPECIAL_TYPES.has(tag.toLowerCase()),
      });
    }
    return rows.sort((a, b) => (a.special === b.special ? a.tag.localeCompare(b.tag) : a.special ? 1 : -1));
  });

  /** 结构校验：tag 唯一 / 组引用存在 / route 引用存在 */
  readonly issues = computed<string[]>(() => {
    const cfg = this.parsed();
    if (!cfg) return [];
    const out = [...(Array.isArray(cfg['outbounds']) ? (cfg['outbounds'] as Record<string, unknown>[]) : []),
                 ...(Array.isArray(cfg['endpoints']) ? (cfg['endpoints'] as Record<string, unknown>[]) : [])];
    const tags = new Map<string, number>();
    for (const o of out) {
      const t = String(o['tag'] ?? '');
      tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    const list: string[] = [];
    for (const [t, n] of tags) if (n > 1) list.push(`tag 重复：${t} ×${n}`);
    for (const o of out) {
      const members = o['outbounds'];
      if (!Array.isArray(members)) continue;
      for (const m of members as string[]) {
        if (!tags.has(m)) list.push(`组 ${String(o['tag'])} 引用了不存在的 ${m}`);
      }
    }
    const route = cfg['route'] as Record<string, unknown> | undefined;
    const rules = Array.isArray(route?.['rules']) ? (route!['rules'] as Record<string, unknown>[]) : [];
    for (const r of rules) {
      const ref = r['outbound'];
      if (typeof ref === 'string' && !tags.has(ref)) list.push(`route 规则引用了不存在的 ${ref}`);
    }
    return list;
  });

  readonly diff = computed<{ lines: DiffLine[]; adds: number; dels: number }>(() => {
    const a = this.original().split('\n');
    const b = this.raw().split('\n');
    if (a.length * b.length > 4_000_000) return { lines: [], adds: 0, dels: 0 };
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const lines: DiffLine[] = [];
    let adds = 0;
    let dels = 0;
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ kind: 'del', text: a[i++] });
        dels++;
      } else {
        lines.push({ kind: 'add', text: b[j++] });
        adds++;
      }
    }
    while (i < n) {
      lines.push({ kind: 'del', text: a[i++] });
      dels++;
    }
    while (j < m) {
      lines.push({ kind: 'add', text: b[j++] });
      adds++;
    }
    return { lines: lines.slice(0, 60), adds, dels };
  });

  async reload(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    try {
      const res = await this.router.config(this.backend());
      this.raw.set(res.config);
      this.original.set(res.config);
      this.sha.set(res.sha256);
      this.size.set(res.size);
      this.loaded.set(true);
      this.log.set(`已读取 ${res.host} · ${res.size}B · sha ${res.sha256.slice(0, 12)} · ${res.ms}ms`);
    } catch (e) {
      this.err.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  onEdit(v: string): void {
    this.raw.set(v);
  }

  toggleEdit(): void {
    if (this.editing() && this.raw() !== this.original()) {
      if (!confirm('放弃未应用的修改？')) return;
      this.raw.set(this.original());
    }
    this.editing.set(!this.editing());
  }

  revert(): void {
    this.raw.set(this.original());
    this.log.set('已还原为读取到的内容');
  }

  async check(): Promise<void> {
    if (this.jsonError()) {
      this.err.set('JSON 语法错误：' + this.jsonError());
      return;
    }
    this.busy.set(true);
    this.err.set('');
    try {
      const res = await this.router.check(this.backend(), this.raw());
      this.log.set(res.ok ? `✓ sing-box check 通过（${res.host}）` : `✗ check 未通过：${res.output}`);
      if (!res.ok) this.err.set('sing-box check 未通过');
    } catch (e) {
      this.err.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  async apply(): Promise<void> {
    if (this.jsonError()) {
      this.err.set('JSON 语法错误，已阻止应用：' + this.jsonError());
      return;
    }
    if (this.issues().length) {
      if (!confirm(`结构校验有 ${this.issues().length} 条问题，仍要应用？\n\n` + this.issues().slice(0, 8).join('\n'))) return;
    } else if (!confirm(`把配置写回 ${this.host()} 并重启 sing-box？\n断流约 1 秒，失败会自动回滚。`)) {
      return;
    }
    this.busy.set(true);
    this.err.set('');
    try {
      const res = await this.router.apply(this.backend(), this.raw(), this.sha());
      const summary = res.changed
        ? `✓ 已应用并重启（${res.ms}ms）：${res.log}`
        : `未变化，跳过重启：${res.log}`;
      this.editing.set(false);
      await this.reload();
      // reload() 会覆盖 log，把应用结果补在最前面
      this.log.set(summary + '\n' + (this.log() ?? ''));
    } catch (e) {
      this.err.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  async restart(): Promise<void> {
    if (!confirm(`重启 ${this.host()} 上的 sing-box？断流约 1 秒。`)) return;
    this.busy.set(true);
    this.err.set('');
    try {
      const res = await this.router.restart(this.backend());
      this.log.set(`✓ 已重启（${res.ms}ms）：${res.log}`);
    } catch (e) {
      this.err.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  private msg(e: unknown): string {
    const anyE = e as { error?: { error?: string }; message?: string };
    return anyE?.error?.error ?? anyE?.message ?? String(e);
  }

  private maskCredential(o: Record<string, unknown>): string {
    for (const k of ['password', 'uuid', 'psk', 'private_key']) {
      const v = o[k];
      if (typeof v === 'string' && v) return `${k}=${'•'.repeat(Math.min(8, Math.max(4, v.length)))}`;
    }
    if (o['username']) return `user=${String(o['username'])}`;
    return '—';
  }

  trackTag(_i: number, r: NodeRow): string {
    return r.tag;
  }
}