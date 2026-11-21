import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Backend } from './models';
import { RouterService } from './router.service';
import { BackendsService } from './backends.service';
import { MonacoEditorComponent } from './monaco-editor';
import {
  AnyObj,
  ConfigDoc,
  addNode,
  deleteImpact,
  deleteNode,
  findNode,
  groups,
  nodes,
  parseConfig,
  serializeConfig,
  updateNode,
  validateDoc,
} from './config-ops';
import { ParsedNode, parseShareLinks } from './share-link';

type FormMode = 'none' | 'add' | 'edit';

interface NodeForm {
  tag: string;
  type: string;
  server: string;
  server_port: number;
  method: string;
  password: string;
  uuid: string;
  alter_id: number;
  security: string;
  flow: string;
  tls: boolean;
  tls_server_name: string;
  tls_insecure: boolean;
  transport: 'none' | 'ws' | 'grpc';
  transport_path: string;
  transport_service: string;
  socks_version: string;
}

const NODE_TYPES = ['shadowsocks', 'vmess', 'vless', 'trojan', 'socks', 'hysteria2', 'tuic', 'anytls'];

function emptyForm(): NodeForm {
  return {
    tag: '',
    type: 'shadowsocks',
    server: '',
    server_port: 443,
    method: 'aes-256-gcm',
    password: '',
    uuid: '',
    alter_id: 0,
    security: 'auto',
    flow: '',
    tls: false,
    tls_server_name: '',
    tls_insecure: false,
    transport: 'none',
    transport_path: '/',
    transport_service: '',
    socks_version: '5',
  };
}

/** 「配置」子页：读/校验/表单增删改/导入/应用/重启 sing-box 配置 */
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

  // —— 节点表单 ——
  readonly formMode = signal<FormMode>('none');
  readonly form = signal<NodeForm>(emptyForm());
  readonly editingTag = signal('');
  readonly nodeTypes = NODE_TYPES;

  // —— 导入 ——
  readonly importOpen = signal(false);
  readonly importText = signal('');
  readonly importGroups = signal<string[]>([]);
  readonly importResult = signal<ParsedNode[]>([]);

  // —— 删除 ——
  readonly deleteTag = signal('');

  constructor() {
    effect(() => {
      const b = this.backend();
      const vaultKey = this.bsvc.globalKey();
      if (!b.api || !vaultKey) return;
      void this.reload();
    });
  }

  // ---------- 只读派生 ----------
  readonly doc = computed<ConfigDoc | null>(() => {
    try {
      return parseConfig(this.raw());
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

  readonly nodeRows = computed(() => {
    const d = this.doc();
    return d ? nodes(d) : [];
  });

  readonly groupNames = computed(() => {
    const d = this.doc();
    return d ? groups(d).map((g) => String(g['tag'])) : [];
  });

  readonly issues = computed(() => {
    const d = this.doc();
    return d ? validateDoc(d) : [];
  });

  readonly deleteInfo = computed(() => {
    const d = this.doc();
    const tag = this.deleteTag();
    if (!d || !tag) return null;
    return deleteImpact(d, tag);
  });

  readonly diff = computed<{ lines: { kind: 'add' | 'del'; text: string }[]; adds: number; dels: number }>(() => {
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
    const lines: { kind: 'add' | 'del'; text: string }[] = [];
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

  // ---------- 读取 / 应用 ----------
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
      const summary = res.changed ? `✓ 已应用并重启（${res.ms}ms）：${res.log}` : `未变化，跳过重启：${res.log}`;
      this.editing.set(false);
      await this.reload();
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

  // ---------- 表单：新增 / 编辑 ----------
  openAdd(): void {
    if (!this.doc()) {
      this.err.set('当前配置无法解析，无法用表单编辑；请先修好 JSON');
      return;
    }
    this.editingTag.set('');
    this.form.set(emptyForm());
    this.formMode.set('add');
  }

  openEdit(tag: string): void {
    const d = this.doc();
    if (!d) return;
    const o = findNode(d, tag);
    if (!o) return;
    const tls = (o['tls'] ?? {}) as AnyObj;
    const tr = (o['transport'] ?? {}) as AnyObj;
    this.editingTag.set(tag);
    this.form.set({
      tag,
      type: String(o['type'] ?? 'shadowsocks'),
      server: String(o['server'] ?? ''),
      server_port: Number(o['server_port'] ?? 0),
      method: String(o['method'] ?? ''),
      password: String(o['password'] ?? ''),
      uuid: String(o['uuid'] ?? ''),
      alter_id: Number(o['alter_id'] ?? 0),
      security: String(o['security'] ?? 'auto'),
      flow: String(o['flow'] ?? ''),
      tls: tls['enabled'] === true,
      tls_server_name: String(tls['server_name'] ?? ''),
      tls_insecure: tls['insecure'] === true,
      transport: (tr['type'] as 'ws' | 'grpc') ?? 'none',
      transport_path: String(tr['path'] ?? '/'),
      transport_service: String(tr['service_name'] ?? ''),
      socks_version: String(o['version'] ?? '5'),
    });
    this.formMode.set('edit');
  }

  cancelForm(): void {
    this.formMode.set('none');
  }

  patch<K extends keyof NodeForm>(key: K, value: NodeForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  toggleFormGroup(name: string, on: boolean): void {
    // 仅用于新增时选择加入哪些组；编辑模式下沿用当前归属
    this.formGroups.update((list) => (on ? [...new Set([...list, name])] : list.filter((x) => x !== name)));
  }

  readonly formGroups = signal<string[]>([]);

  submitForm(): void {
    const d = this.doc();
    if (!d) return;
    const f = this.form();
    if (!f.tag.trim() || !f.server.trim() || !f.server_port) {
      this.err.set('标签 / 服务器 / 端口 必填');
      return;
    }
    const node: AnyObj = { type: f.type, tag: f.tag.trim(), server: f.server.trim(), server_port: f.server_port };
    switch (f.type) {
      case 'shadowsocks':
        if (!f.method.trim() || !f.password) {
          this.err.set('shadowsocks 需要 method 与 password');
          return;
        }
        node['method'] = f.method.trim();
        node['password'] = f.password;
        break;
      case 'vmess':
        if (!f.uuid.trim()) {
          this.err.set('vmess 需要 uuid');
          return;
        }
        node['uuid'] = f.uuid.trim();
        node['security'] = f.security || 'auto';
        node['alter_id'] = f.alter_id;
        break;
      case 'vless':
        if (!f.uuid.trim()) {
          this.err.set('vless 需要 uuid');
          return;
        }
        node['uuid'] = f.uuid.trim();
        if (f.flow.trim()) node['flow'] = f.flow.trim();
        break;
      case 'trojan':
      case 'hysteria2':
      case 'tuic':
      case 'anytls':
        if (!f.password) {
          this.err.set(`${f.type} 需要密码`);
          return;
        }
        node['password'] = f.password;
        break;
      case 'socks':
        node['version'] = f.socks_version || '5';
        if (f.password) {
          node['username'] = f.uuid || '';
          node['password'] = f.password;
        }
        break;
    }
    if (f.tls && f.type !== 'shadowsocks' && f.type !== 'socks') {
      const tls: AnyObj = { enabled: true, server_name: f.tls_server_name || f.server };
      if (f.tls_insecure) tls['insecure'] = true;
      node['tls'] = tls;
    }
    if (f.transport !== 'none') {
      node['transport'] =
        f.transport === 'ws'
          ? { type: 'ws', path: f.transport_path || '/' }
          : { type: 'grpc', service_name: f.transport_service || '' };
    }

    try {
      if (this.formMode() === 'add') {
        const tag = addNode(d, node, this.formGroups());
        this.log.set(`已生成新节点 ${tag}（尚未应用，先看 diff 再点「应用并重启」）`);
      } else {
        const tag = this.editingTag();
        updateNode(d, tag, node, this.formGroups().length ? this.formGroups() : undefined);
        this.log.set(`已修改节点 ${tag}（尚未应用）`);
      }
      this.formMode.set('none');
      this.enterReview(d);
    } catch (e) {
      this.err.set((e as Error).message);
    }
  }

  // ---------- 删除（引用联动）----------
  askDelete(tag: string): void {
    this.deleteTag.set(tag);
    const info = this.deleteInfo();
    if (!info) return;
    if (info.blocked) {
      this.err.set(`不能删除 ${tag}：` + info.reasons.join('；'));
      return;
    }
    const lines = [
      `删除节点 ${tag}？`,
      info.groups.length ? `· 会从 ${info.groups.length} 个分组中移除：${info.groups.join('、')}` : '· 没有被任何分组引用',
      info.isDefault.length ? `· 这些组的 default 会改成第一个成员：${info.isDefault.map((x) => x.group).join('、')}` : '',
      '· 生成后先看 diff，再点「应用并重启」',
    ].filter(Boolean);
    if (!confirm(lines.join('\n'))) {
      this.deleteTag.set('');
      return;
    }
    const d = this.doc();
    if (!d) return;
    try {
      deleteNode(d, tag);
      this.log.set(`已从配置中移除节点 ${tag}（尚未应用）`);
      this.enterReview(d);
    } catch (e) {
      this.err.set((e as Error).message);
    } finally {
      this.deleteTag.set('');
    }
  }

  // ---------- 导入分享链接 ----------
  toggleImport(): void {
    this.importOpen.update((v) => !v);
  }

  onImportText(v: string): void {
    this.importText.set(v);
    this.importResult.set(parseShareLinks(v));
  }

  toggleImportGroup(name: string, on: boolean): void {
    this.importGroups.update((list) => (on ? [...new Set([...list, name])] : list.filter((x) => x !== name)));
  }

  importAll(): void {
    const d = this.doc();
    if (!d) return;
    const good = this.importResult().filter((r) => r.ok && r.node);
    if (!good.length) {
      this.err.set('没有可导入的链接（检查格式或协议是否支持）');
      return;
    }
    const tags: string[] = [];
    for (const r of good) tags.push(addNode(d, r.node as AnyObj, this.importGroups()));
    this.log.set(`已导入 ${tags.length} 个节点：${tags.join('、')}（尚未应用）`);
    this.importOpen.set(false);
    this.importText.set('');
    this.importResult.set([]);
    this.enterReview(d);
  }

  // ---------- 内部 ----------
  private enterReview(d: ConfigDoc): void {
    this.raw.set(serializeConfig(d, this.original()));
    this.editing.set(true);
  }

  private msg(e: unknown): string {
    const anyE = e as { error?: { error?: string }; message?: string };
    return anyE?.error?.error ?? anyE?.message ?? String(e);
  }

  maskCredential(o: AnyObj): string {
    for (const k of ['password', 'uuid', 'psk', 'private_key']) {
      const v = o[k];
      if (typeof v === 'string' && v) return `${k}=${'•'.repeat(Math.min(8, Math.max(4, v.length)))}`;
    }
    if (o['username']) return `user=${String(o['username'])}`;
    return '—';
  }
}