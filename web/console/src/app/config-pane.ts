import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Backend } from './models';
import { RouterCredInfo, RouterService } from './router.service';
import { BackendsService } from './backends.service';
import { MonacoEditorComponent } from './monaco-editor';
import { RuleSelector } from './rule-selector';
import { AnyObj, ConfigDoc, addNode, deleteImpact, deleteNode, findNode, groups, nodes, parseConfig, serializeConfig, updateNode, validateDoc } from './config-ops';
import { ParsedNode, parseShareLinks } from './share-link';
import { NodeForm, NODE_TYPES, buildNode, emptyForm, formFromNode } from './node-form';
import { lineDiff } from './line-diff';
import { errMsg } from './util';

type FormMode = 'none' | 'add' | 'edit';

/**
 * 「配置」子页 — 路由 config.json 的完整生命周期：
 *
 *   连接门禁（缺密钥/凭据时像登录页）→ 读取（sha 乐观锁基准）
 *   → 查看节点清单 / 表单增删改 / 分享链接导入 / Monaco 手改
 *   → 所有改动先「暂存」（黄色横幅 + diff 预览）
 *   → 校验（路由上 sing-box check）→ 应用并重启（99 编排，失败自动回滚）
 *
 * 结构化编辑逻辑在 config-ops.ts，表单转换在 node-form.ts，diff 在 line-diff.ts；
 * 本组件只做状态编排与用户交互。
 */
@Component({
  selector: 'app-config-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MonacoEditorComponent, RuleSelector],
  templateUrl: './config-pane.html',
})
export class ConfigPane {
  readonly backend = input.required<Backend>();

  private readonly router = inject(RouterService);
  private readonly bsvc = inject(BackendsService);

  // —— 配置文本与元信息 ——
  readonly host = computed(() => this.router.host(this.backend()));
  readonly raw = signal('');      // 当前编辑中的文本（可能与 original 不同 = 暂存）
  readonly original = signal(''); // 最近一次从路由读到的原文（diff/还原基准）
  readonly sha = signal('');      // 原文 sha256（apply 的 expectSha 乐观锁）
  readonly size = signal(0);
  readonly editing = signal(false); // Monaco 编辑视图开关
  readonly busy = signal(false);
  readonly err = signal('');
  readonly log = signal('');
  readonly loaded = signal(false);

  // —— 节点表单（模型/转换见 node-form.ts）——
  readonly formMode = signal<FormMode>('none');
  readonly form = signal<NodeForm>(emptyForm());
  readonly formGroups = signal<string[]>([]); // 表单勾选的分组归属
  readonly editingTag = signal('');
  readonly nodeTypes = NODE_TYPES;

  // —— 分流规则选择器（只读视图内；基准是原始配置，见 origDoc）——
  readonly rulesOpen = signal(false);

  // —— 分享链接导入 ——
  readonly importOpen = signal(false);
  readonly importText = signal('');
  readonly importGroups = signal<string[]>([]);
  readonly importResult = signal<ParsedNode[]>([]);

  // —— 连接门禁（连不上时像登录页一样要求填凭据）——
  readonly gate = signal(false);
  readonly gateError = signal('');
  readonly gateKey = signal('');
  readonly gateUser = signal('root');
  readonly gatePass = signal('');

  // —— 路由 SSH 凭据面板（只提交给 99 落盘，不存浏览器）——
  readonly credsOpen = signal(false);
  readonly credsUser = signal('root');
  readonly credsPassword = signal('');
  readonly credsHosts = signal<RouterCredInfo[]>([]);
  readonly credsAllow = signal<string[]>([]);

  constructor() {
    // 后端或全局密钥变化时自动重读；没密钥直接进连接页，别停在「读取中」
    effect(() => {
      const b = this.backend();
      const vaultKey = this.bsvc.globalKey();
      if (!b.api) return;
      if (!vaultKey) {
        this.gateError.set('请先填写 clash 密钥（路由管理密钥）与路由 SSH 账号');
        this.gate.set(true);
        return;
      }
      void this.reload();
    });
  }

  // ---------- 只读派生 ----------

  /** 当前文本的结构化文档（解析失败为 null，表单/清单随之不可用） */
  readonly doc = computed<ConfigDoc | null>(() => {
    try {
      return parseConfig(this.raw());
    } catch {
      return null;
    }
  });

  /** 原始配置（最近一次读取）的结构化文档 — 分流规则选择器的稳定基准，不随暂存文本漂移 */
  readonly origDoc = computed<ConfigDoc | null>(() => {
    try {
      return parseConfig(this.original());
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

  /** 有暂存未应用的改动（黄色横幅的开关） */
  readonly pending = computed(() => this.raw() !== this.original() && this.raw() !== '');

  /** 结构预检（tag 重复 / 组引用 / route 引用；最终以路由上的 check 为准） */
  readonly issues = computed(() => {
    const d = this.doc();
    return d ? validateDoc(d) : [];
  });

  readonly diff = computed(() => lineDiff(this.original(), this.raw()));

  // ---------- 读取 / 校验 / 应用 / 重启 ----------

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
      const m = errMsg(e);
      this.err.set(m);
      // 没凭据 / 密钥错 / SSH 失败 / 超时 → 弹连接页（像登录）
      if (/未配置路由凭据|bad key|401|ssh|Permission denied|超时|失败/i.test(m)) {
        this.gateError.set(m);
        this.gate.set(true);
        this.gateKey.set(this.bsvc.globalKey());
        void this.loadCreds();
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** 连接页提交：先存 clash 密钥（如有），再存 SSH 凭据（如有），然后重读配置 */
  async connect(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    try {
      const key = this.gateKey().trim();
      if (key) {
        // 这个密钥就是 clash_api 的 secret：既用于 99 接口鉴权，也用于页面直连路由
        this.bsvc.setGlobalKey(key);
        this.bsvc.updateKey(this.backend(), key);
      }
      const user = this.gateUser().trim();
      const pass = this.gatePass();
      if (user && pass) {
        await this.router.setCredentials(this.backend(), this.host(), user, pass, this.backend().name);
        this.gatePass.set(''); // 口令只经过一次，立即从页面内存清掉
      }
      await this.reload();
      if (this.loaded()) {
        this.gate.set(false);
        this.gateError.set('');
        this.log.set(`已连接 ${this.host()}，配置可编辑`);
      }
    } catch (e) {
      this.gate.set(true);
      this.gateError.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  closeGate(): void {
    this.gate.set(false);
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
      this.err.set(errMsg(e));
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
      this.log.set(summary + '\n' + (this.log() ?? '')); // reload 会覆盖 log，把应用结果补在最前
    } catch (e) {
      this.err.set(errMsg(e));
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
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- 节点表单：新增 / 编辑 ----------

  openAdd(): void {
    if (!this.doc()) {
      this.err.set('当前配置无法解析，无法用表单编辑；请先修好 JSON');
      return;
    }
    this.editingTag.set('');
    this.form.set(emptyForm());
    this.formGroups.set([]);
    this.formMode.set('add');
    this.scrollFormIntoView();
  }

  openEdit(tag: string): void {
    const d = this.doc();
    if (!d) return;
    const o = findNode(d, tag);
    if (!o) return;
    this.editingTag.set(tag);
    this.form.set(formFromNode(tag, o));
    // 编辑模式预勾当前归属，取消勾选 = 从该组移除（updateNode 会联动 default）
    this.formGroups.set(groups(d).filter((g) => (g['outbounds'] as string[] | undefined)?.includes(tag)).map((g) => String(g['tag'])));
    this.formMode.set('edit');
    this.scrollFormIntoView();
  }

  cancelForm(): void {
    this.formMode.set('none');
  }

  patch<K extends keyof NodeForm>(key: K, value: NodeForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  toggleFormGroup(name: string, on: boolean): void {
    this.formGroups.update((list) => (on ? [...new Set([...list, name])] : list.filter((x) => x !== name)));
  }

  /** 提交表单：校验 + 组装（node-form.ts）→ 写进文档 → 进入暂存复核 */
  submitForm(): void {
    const d = this.doc();
    if (!d) return;
    const built = buildNode(this.form());
    if (!built.ok) {
      this.err.set(built.error);
      return;
    }
    try {
      if (this.formMode() === 'add') {
        const tag = addNode(d, built.node, this.formGroups());
        this.log.set(`已生成新节点 ${tag}（尚未应用，先看 diff 再点「应用并重启」）`);
      } else {
        const tag = this.editingTag();
        updateNode(d, tag, built.node, this.formGroups());
        this.log.set(`已修改节点 ${tag}（尚未应用）`);
      }
      this.formMode.set('none');
      this.enterReview(d);
    } catch (e) {
      this.err.set((e as Error).message);
    }
  }

  // ---------- 删除（引用联动，见 config-ops.deleteImpact/deleteNode）----------

  askDelete(tag: string): void {
    const d = this.doc();
    if (!d) return;
    const info = deleteImpact(d, tag);
    if (info.blocked) {
      this.err.set(`不能删除 ${tag}：` + info.reasons.join('；'));
      return;
    }
    const lines = [
      `删除节点 ${tag}？（先暂存，点「应用并重启」才会写回路由）`,
      info.groups.length ? `· 会从 ${info.groups.length} 个分组中移除：${info.groups.join('、')}` : '· 没有被任何分组引用',
      info.isDefault.length ? `· 这些组的 default 会改成第一个成员：${info.isDefault.map((x) => x.group).join('、')}` : '',
      '· 生成后先看 diff，再点「应用并重启」',
    ].filter(Boolean);
    if (!confirm(lines.join('\n'))) return;
    try {
      deleteNode(d, tag);
      this.log.set(`已从配置中移除节点 ${tag}（尚未应用）`);
      this.enterReview(d);
    } catch (e) {
      this.err.set((e as Error).message);
    }
  }

  // ---------- 分享链接导入（解析见 share-link.ts）----------

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

  // ---------- 分流规则选择器（模型见 rule-model.ts，交互见 rule-selector.ts）----------

  /** 选择器产出新文档 → 走既有暂存复核（serializeConfig 序列化 + diff + 应用并重启） */
  onRulesDoc(d: ConfigDoc): void {
    this.enterReview(d);
  }

  // ---------- 路由 SSH 凭据面板 ----------

  async toggleCreds(): Promise<void> {
    const open = !this.credsOpen();
    this.credsOpen.set(open);
    if (open) await this.loadCreds();
  }

  async loadCreds(): Promise<void> {
    try {
      const res = await this.router.credentials(this.backend());
      this.credsHosts.set(res.hosts ?? []);
      this.credsAllow.set(res.allow ?? []);
      const me = (res.hosts ?? []).find((h) => h.host === this.host());
      if (me?.user) this.credsUser.set(me.user);
    } catch (e) {
      this.err.set(errMsg(e));
    }
  }

  async saveCreds(): Promise<void> {
    const host = this.host();
    const user = this.credsUser().trim();
    const pw = this.credsPassword();
    if (!user || !pw) {
      this.err.set('用户名与口令都不能为空');
      return;
    }
    this.busy.set(true);
    this.err.set('');
    try {
      await this.router.setCredentials(this.backend(), host, user, pw, this.backend().name);
      this.credsPassword.set(''); // 提交后立刻从页面内存清掉
      this.credsOpen.set(false);
      this.log.set(`已保存 ${host} 的 SSH 凭据（99 上 0600 落盘，页面不再保留口令）`);
      await this.reload();
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  async removeCreds(host: string): Promise<void> {
    if (!confirm(`删除 ${host} 的 SSH 凭据？`)) return;
    try {
      await this.router.deleteCredentials(this.backend(), host);
      await this.loadCreds();
      this.log.set(`已删除 ${host} 的凭据`);
    } catch (e) {
      this.err.set(errMsg(e));
    }
  }

  // ---------- 内部 ----------

  /** 结构化改动落回文本：按原文件的缩进/行尾重新序列化，并切到 diff 复核视图 */
  private enterReview(d: ConfigDoc): void {
    this.raw.set(serializeConfig(d, this.original()));
    this.editing.set(true);
  }

  /** 表单在清单下方，打开时滚到可见处 */
  private scrollFormIntoView(): void {
    setTimeout(() => {
      document.getElementById('cfg-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  }
}