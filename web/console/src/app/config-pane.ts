import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Backend } from './models';
import { RouterCredInfo, RouterService } from './router.service';
import { BackendsService } from './backends.service';
import { MonacoEditorComponent } from './monaco-editor';
import { RuleSelector } from './rule-selector';
import { GroupBoard } from './group-board';
import { AnyObj, ConfigDoc, addNode, deleteImpact, deleteNode, findNode, groups, nodes, parseConfig, serializeConfig, updateNode, validateDoc } from './config-ops';
import { ParsedNode, parseShareLinks } from './share-link';
import { NodeForm, NODE_TYPES, buildNode, emptyForm, formFromNode } from './node-form';
import { lineDiff } from './line-diff';
import { errMsg } from './util';

/** 节点表单状态机：none=关闭 / add=新增 / edit=编辑既有节点 */
type FormMode = 'none' | 'add' | 'edit';

/**
 * 「配置」子页 — 路由 config.json 的状态编排（本组件只管状态与交互）：
 *
 *   连接门禁（缺 clash 密钥/SSH 凭据时像登录页一样要求补填）
 *   → 读取（记录原文 sha256，作为 apply 的乐观锁基准）
 *   → 只读节点表 / 节点表单增删改 / 分享链接导入 / Monaco 手改
 *   → 所有改动先「暂存」：enterReview 把文档序列化回文本，黄色横幅 + diff 预览
 *   → 校验（本地 JSON/结构预检 + 路由上 sing-box check）
 *   → 应用并重启（99 编排，expectSha 防并发覆盖，失败自动回滚）/ 撤销还原
 *
 * 面板接入：分流规则 rule-selector 与分组看板 group-board 都产出新 ConfigDoc，
 * 统一走暂存复核管线；另有路由 SSH 凭据面板（只提交给 99 落盘，不存浏览器）
 * 与分享链接导入（share-link.ts 解析后批量 addNode）。
 *
 * 结构化编辑逻辑在 config-ops.ts，表单转换在 node-form.ts，diff 在 line-diff.ts。
 */
@Component({
  selector: 'app-config-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MonacoEditorComponent, RuleSelector, GroupBoard],
  templateUrl: './config-pane.html',
})
export class ConfigPane {
  /** 当前选中的后端（路由），父组件传入；切换时由 effect 触发重读 */
  readonly backend = input.required<Backend>();

  private readonly router = inject(RouterService); // 99 的路由配置/凭据/校验/重启接口
  private readonly bsvc = inject(BackendsService); // 全局 clash 密钥与后端清单

  // —— 配置文本与元信息 ——
  /** 当前路由 host（工具栏/确认弹窗/凭据面板展示用） */
  readonly host = computed(() => this.router.host(this.backend()));
  readonly raw = signal('');      // 当前编辑中的文本（可能与 original 不同 = 暂存）
  readonly original = signal(''); // 最近一次从路由读到的原文（diff/还原基准）
  readonly sha = signal('');      // 原文 sha256（apply 的 expectSha 乐观锁）
  readonly size = signal(0);      // 原文字节数（工具栏展示）
  readonly editing = signal(false); // Monaco 编辑视图开关（true=编辑+diff，false=只读表）
  readonly busy = signal(false);  // 有请求在途：禁用按钮防并发操作
  readonly err = signal('');      // 红色错误横幅内容
  readonly log = signal('');      // 底部操作日志（读取/校验/应用/重启结果）
  readonly loaded = signal(false); // 是否成功读到过配置（只读表与多数按钮的前提）

  // —— 节点表单（模型/转换见 node-form.ts）——
  readonly formMode = signal<FormMode>('none'); // 表单状态机：none→add/edit→提交后回 none
  readonly form = signal<NodeForm>(emptyForm()); // 表单字段值（patch 单字段受控更新）
  readonly formGroups = signal<string[]>([]); // 表单勾选的分组归属
  readonly editingTag = signal(''); // edit 模式下正在改的节点 tag（add 模式为空）
  readonly nodeTypes = NODE_TYPES;  // 类型下拉的可选协议清单

  // —— 分流规则选择器（面板在页面底部；基准=当前文本 workDoc，产出新文档走暂存）——
  readonly rulesOpen = signal(false); // 分流规则面板开关

  // —— 分组看板（拖拽改分组成员=改 config 结构，同样走暂存复核）——
  readonly boardOpen = signal(false); // 分组看板面板开关

  // —— 分享链接导入（解析见 share-link.ts）——
  readonly importOpen = signal(false); // 导入面板开关
  readonly importText = signal('');    // 粘贴的链接文本（每行一个）
  readonly importGroups = signal<string[]>([]); // 导入节点要加入的分组
  readonly importResult = signal<ParsedNode[]>([]); // 逐行解析结果（成功/失败预览）

  // —— 连接门禁（连不上时像登录页一样要求填凭据）——
  readonly gate = signal(false);      // true=显示连接页，遮住整个子页
  readonly gateError = signal('');    // 连接页上的错误提示
  readonly gateKey = signal('');      // 待提交的 clash 密钥（留空=沿用全局已填的）
  readonly gateUser = signal('root'); // 待提交的 SSH 用户名
  readonly gatePass = signal('');     // 待提交的 SSH 口令（提交后立即清空）

  // —— 路由 SSH 凭据面板（只提交给 99 落盘，不存浏览器）——
  readonly credsOpen = signal(false);  // 凭据面板开关
  readonly credsUser = signal('root'); // 表单用户名（打开面板时回填已存值）
  readonly credsPassword = signal(''); // 表单口令（保存后立即清空）
  readonly credsHosts = signal<RouterCredInfo[]>([]); // 99 上已配置凭据的主机清单
  readonly credsAllow = signal<string[]>([]);         // 99 允许配置凭据的主机白名单

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

  /**
   * 看板/规则面板的基准文档：当前文本的别名（workDoc=doc），暂存后仍可连续拖拽。
   * 与 origDoc 的区别：workDoc 随暂存文本漂移，origDoc 固定为最近一次读取的原文。
   */
  readonly workDoc = computed<ConfigDoc | null>(() => this.doc());

  /** 原始配置（最近一次读取）的结构化文档 — 不随暂存文本漂移的稳定基准 */
  readonly origDoc = computed<ConfigDoc | null>(() => {
    try {
      return parseConfig(this.original());
    } catch {
      return null;
    }
  });

  /** JSON 语法错误信息（空串=语法正确；空文本不算错） */
  readonly jsonError = computed(() => {
    if (!this.raw().trim()) return '';
    try {
      JSON.parse(this.raw());
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  });

  /** 只读节点表的行（代理节点 + endpoints + 特殊出站；解析失败为空表） */
  readonly nodeRows = computed(() => {
    const d = this.doc();
    return d ? nodes(d) : [];
  });

  /** 现有分组 tag 清单（节点表单/导入面板的勾选项） */
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

  /** 原文 vs 暂存文本的行级 diff（横幅计数 + 编辑视图预览） */
  readonly diff = computed(() => lineDiff(this.original(), this.raw()));

  // ---------- 读取 / 校验 / 应用 / 重启 ----------

  /** 从路由重读配置：raw/original/sha 一起重置（放弃暂存），失败按签名弹门禁 */
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

  /** 关闭连接页（取消补凭据，回到只读主视图） */
  closeGate(): void {
    this.gate.set(false);
  }

  /** Monaco 双向绑定：手改文本只进暂存（raw），不直接写回路由 */
  onEdit(v: string): void {
    this.raw.set(v);
  }

  /** 切换 Monaco 编辑视图；退出时若有暂存先确认，放弃则还原为原文 */
  toggleEdit(): void {
    if (this.editing() && this.raw() !== this.original()) {
      if (!confirm('放弃未应用的修改？')) return;
      this.raw.set(this.original());
    }
    this.editing.set(!this.editing());
  }

  /** 撤销：丢弃全部暂存，回到最近一次读取的原文 */
  revert(): void {
    this.raw.set(this.original());
    this.log.set('已还原为读取到的内容');
  }

  /** 校验：先本地 JSON 语法拦截，再送路由跑 sing-box check（不写回不重启） */
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

  /**
   * 应用并重启：JSON 语法错直接阻止；结构预检有问题列出来让用户确认。
   * 带 expectSha 乐观锁——原文在读取后被别人改过时 99 会拒绝，防并发覆盖。
   * 成功后重读刷新基准，并把应用结果补在日志最前（reload 会覆盖 log）。
   */
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
      this.log.set(summary + '\n' + this.log()); // reload 会覆盖 log，把应用结果补在最前
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 只重启 sing-box（不写配置）：断流约 1 秒，先确认 */
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

  /** 打开新增表单：配置解析失败时拒绝（表单编辑依赖结构化文档） */
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

  /** 打开编辑表单：按 tag 找到节点回填字段，并预勾当前分组归属 */
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

  /** 关闭表单，丢弃未提交的字段值 */
  cancelForm(): void {
    this.formMode.set('none');
  }

  /** 受控更新单个表单字段（模板里所有 input/select 都走这里） */
  patch<K extends keyof NodeForm>(key: K, value: NodeForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  /** 表单里勾选/取消分组归属（取消=提交时从该组移除，default 由 updateNode 联动） */
  toggleFormGroup(name: string, on: boolean): void {
    this.formGroups.update((list) => this.toggledName(list, name, on));
  }

  /** 增/删一个分组名（去重追加；取消则移除），返回新数组不改入参 */
  private toggledName(list: string[], name: string, on: boolean): string[] {
    const has = list.includes(name);
    if (on && !has) return [...list, name];
    if (!on && has) return list.filter((x) => x !== name);
    return list;
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

  /** 删除前先看引用影响（deleteImpact）：被 route 引用等情形直接拒绝；
   *  可删时列出分组移除/default 联动后果，确认后 deleteNode 并进暂存复核 */
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

  // ---------- 分组看板（模型见 group-board-model.ts，交互见 group-board.ts）----------

  /** 看板拖拽产出新文档 → 同样进暂存复核（改分组成员 = 改 config 结构） */
  onBoardDoc(d: ConfigDoc): void {
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