import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Backend } from './models';
import { RouterCredInfo, RouterService } from './router.service';
import { BackendsService } from './backends.service';
import { MonacoEditorComponent } from './monaco-editor';
import { RuleSelector } from './rule-selector';
import { GroupBoard } from './group-board';
import { NodeCreateDialog } from './node-create-dialog';
import {
  ConfigDoc,
  deleteImpact,
  deleteNode,
  endpoints,
  groups,
  nodes,
  normalizeOutboundTags,
  outbounds,
  parseConfig,
  serializeConfig,
  validateDoc,
} from './config-ops';
import { SharedPoolService, nodeFingerprint } from './shared-pool.service';
import { lineDiff } from './line-diff';
import { errMsg } from './util';
import { ConfirmService } from './confirm.service';

/**
 * 「配置」子页 — 路由 config.json 的状态编排（本组件只管状态与交互）：
 *
 *   连接门禁（缺 clash 密钥/SSH 凭据时像登录页一样要求补填）
 *   → 读取（记录原文 sha256，作为 apply 的乐观锁基准）
 *   → 只读节点表（新增/编辑走 NodeCreateDialog，与流向 ⑤ 同一套）/ Monaco 手改
 *   → 所有改动先「暂存」：enterReview 把文档序列化回文本，黄色横幅 + diff 预览
 *   → 校验（本地 JSON/结构预检 + 路由上 sing-box check）
 *   → 应用并重启（99 编排，expectSha 防并发覆盖，失败自动回滚）/ 撤销还原
 *
 * 工具条收成三档：刷新 / 编辑 JSON / 更多▾（重启、分流规则、分组看板、路由凭据）。
 * 面板接入：分流规则 rule-selector 与分组看板 group-board 都产出新 ConfigDoc，
 * 统一走暂存复核管线；节点增删改走 NodeCreateDialog（表单 / 分享链接两页签）。
 *
 * 结构化编辑逻辑在 config-ops.ts，表单转换在 node-form.ts，diff 在 line-diff.ts。
 */
@Component({
  selector: 'app-config-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MonacoEditorComponent, RuleSelector, GroupBoard, NodeCreateDialog],
  templateUrl: './config-pane.html',
})
export class ConfigPane {
  /** 当前选中的后端（路由），父组件传入；切换时由 effect 触发重读 */
  readonly backend = input.required<Backend>();

  private readonly router = inject(RouterService);
  private readonly poolSvc = inject(SharedPoolService);
  private readonly bsvc = inject(BackendsService);
  private readonly destroyRef = inject(DestroyRef); // 全局 clash 密钥与后端清单
  /** 页内确认框（取代原生 confirm） */
  private readonly ui = inject(ConfirmService);

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
  /** 「更多▾」菜单开关（重启 / 分流规则 / 分组看板 / 路由凭据） */
  readonly moreOpen = signal(false);

  // —— 节点新增/编辑弹窗（表单与分享链接都在弹窗里，见 node-create-dialog.ts）——
  readonly nodeDialog = signal(false);       // 弹窗开关
  readonly nodeEditing = signal<string | null>(null); // null = 新增；有值 = 编辑该 tag
  readonly nodeQ = signal('');               // 节点表检索词

  // —— 分流规则选择器（面板在页面底部；基准=当前文本 workDoc，产出新文档走暂存）——
  readonly rulesOpen = signal(false); // 分流规则面板开关

  // —— 分组看板（拖拽改分组成员=改 config 结构，同样走暂存复核）——
  readonly boardOpen = signal(false); // 分组看板面板开关

  // —— 连接门禁（连不上时像登录页一样要求填凭据）——
  readonly gate = signal(false);      // true=显示连接页，遮住整个子页
  readonly gateError = signal('');    // 连接页上的错误提示
  readonly gateKey = signal('');      // 待提交的 clash 密钥（留空=沿用全局已填的）
  readonly gateUser = signal('root'); // 待提交的 SSH 用户名
  readonly gatePass = signal('');     // 待提交的 SSH 口令（提交后立即清空）
  /** 99 上是否已经存了这台路由的 SSH 凭据（存了就不用每次重填口令） */
  readonly gateCredsSaved = signal(false);
  /** 已存凭据的用户名（页面上回显 root 之类） */
  readonly gateCredsUser = signal('root');
  /** 展开「要改口令」时才显示 SSH 输入框 */
  readonly gateShowPass = signal(false);
  /** 连接页自动重试用过没有（避免死循环） */
  private gateAutoTried = false;
  /** 临时性失败（超时/抖动）的静默重试次数 */
  private transientTries = 0;

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
        // 没密钥时也要问一下 99 有没有存过 SSH 凭据：存过就只差密钥，别再让用户填口令
        void this.refreshGateCreds();
        this.gateError.set('');
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

  /** 共享池里的节点指纹（配置页表格给「已共享」的行打 share 标记） */
  private readonly poolKeys = computed(() => this.poolSvc.fingerprints());

  /** 某个节点是否已在共享池（同配置，tag 不同也算） */
  nodeShared(tag: string): boolean {
    const d = this.doc();
    if (!d) return false;
    const inOb = outbounds(d).find((o) => String(o['tag']) === tag);
    if (inOb) return this.poolKeys().has(nodeFingerprint(inOb, 'outbound'));
    const inEp = endpoints(d).find((o) => String(o['tag']) === tag);
    return inEp ? this.poolKeys().has(nodeFingerprint(inEp, 'endpoint')) : false;
  }

  /** 检索后的节点表行（匹配 tag / 类型 / 服务器 / 所属组，不区分大小写） */
  readonly nodeRowsFiltered = computed(() => {
    const kw = this.nodeQ().trim().toLowerCase();
    const all = this.nodeRows();
    if (!kw) return all;
    return all.filter(
      (n) =>
        n.tag.toLowerCase().includes(kw) ||
        n.type.toLowerCase().includes(kw) ||
        n.server.toLowerCase().includes(kw) ||
        n.groups.some((g) => g.toLowerCase().includes(kw)),
    );
  });

  /** 现有分组 tag 清单（节点弹窗/看板用） */
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
      this.transientTries = 0;
      this.log.set(`已读取 ${res.host} · ${res.size}B · sha ${res.sha256.slice(0, 12)} · ${res.ms}ms`);
    } catch (e) {
      const m = errMsg(e);
      this.err.set(m);
      // 超时/抖动这类临时失败：先静默重试两次再弹页，别让用户白填一遍
      if (/超时|timeout|i\/o timeout|temporary|连接中断/i.test(m) && this.transientTries < 2) {
        this.transientTries += 1;
        this.busy.set(false);
        setTimeout(() => void this.reload(), 700 * this.transientTries);
        return;
      }
      // 没凭据 / 密钥错 / SSH 失败 / 超时 → 弹连接页（像登录）
      if (/未配置路由凭据|bad key|401|ssh|Permission denied|超时|失败/i.test(m)) {
        this.gateError.set(m);
        this.gate.set(true);
        this.gateKey.set(this.bsvc.globalKey());
        await this.refreshGateCreds();
        // 99 已经存了这台路由的 SSH 凭据、本地也有密钥 → 先自动重试一次，别让用户白填一遍口令
        const keyReady = !!this.gateKey().trim();
        if (this.gateCredsSaved() && keyReady && !this.gateAutoTried) {
          this.gateAutoTried = true;
          await this.reload();
          if (this.loaded()) {
            this.gate.set(false);
            this.gateError.set('');
          }
        }
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** 连接页打开时问 99：这台路由的 SSH 凭据存过没有（存过就不再要求填口令） */
  private async refreshGateCreds(): Promise<void> {
    try {
      const res = await this.router.credentials(this.backend());
      const me = (res.hosts ?? []).find((h) => h.host === this.host());
      this.gateCredsSaved.set(!!me?.configured);
      if (me?.user) {
        this.gateCredsUser.set(me.user);
        this.gateUser.set(me.user);
      }
      this.credsHosts.set(res.hosts ?? []);
      this.credsAllow.set(res.allow ?? []);
    } catch {
      // 凭据接口本身失败（如还没填密钥 → 401）→ 状态未知：口令框仍折叠，用户可点「要改口令？」展开
      this.gateCredsSaved.set(false);
      return;
    }
    // 只有明确知道「99 上没存过」才默认展开口令框
    if (!this.gateCredsSaved()) this.gateShowPass.set(true);
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
      // 只在真的填了口令时才更新 99 上的凭据；99 已存过就直接重读
      const user = this.gateUser().trim() || 'root';
      const pass = this.gatePass();
      if (pass) {
        await this.router.setCredentials(this.backend(), this.host(), user, pass, this.backend().name);
        this.gateCredsSaved.set(true);
        this.gateShowPass.set(false);
        this.gatePass.set(''); // 口令只经过一次，立即从页面内存清掉
      }
      await this.reload();
      if (this.loaded()) {
        this.gate.set(false);
        this.gateError.set('');
        this.log.set(`已连接 ${this.host()}，配置可编辑`);
      }
    } catch (e) {
      const m = errMsg(e);
      this.gate.set(true);
      this.gateError.set(m);
      // 明确是「没凭据」才展开口令框，其它错误（网络/密钥）不用重填口令
      if (/未配置路由凭据|Permission denied|SSH 认证失败/i.test(m)) this.gateShowPass.set(true);
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
  async toggleEdit(): Promise<void> {
    if (this.editing() && this.raw() !== this.original()) {
      const ok = await this.ui.ask({
        title: '放弃未应用的修改？',
        body: '退出编辑会丢弃编辑器里尚未写回路由的文本改动。',
        okText: '放弃修改',
        danger: true,
      });
      if (!ok) return;
      this.raw.set(this.original());
    }
    this.editing.set(!this.editing());
  }

  /** 格式化时发现的「需要看一眼」的情况（类型冲突改名 / 旧 tag 残留） */
  readonly fmtWarn = signal<string[]>([]);

  /**
   * 格式化（只改暂存区，不写回路由）：
   *  1) 出站 / 端点 tag 按类型统一大小写 + 同步所有引用（分组成员 / default / detour / 规则出口 / final）：
   *     · 出口分组（selector / urltest）→ 大写；
   *     · 服务器节点 / 端点（endpoints）→ 小写；
   *     · 内置 direct / block 等 → 大写（与内核隐式小写 direct 区分，避免误合并）；
   *     改大小写后撞名且类型相同则合并（`direct` → `DIRECT`），类型不同则改名并提示；
   *  2) JSON 重新按 2 空格缩进排版。
   * 桶 tag（rule_set）对应 NAS 文件名，不在格式化范围内。
   */
  format(): void {
    if (!this.raw()) {
      this.err.set('配置还没读到，先「保存并读取配置」');
      return;
    }
    if (this.jsonError()) {
      this.err.set('JSON 语法错误，先修好再格式化：' + this.jsonError());
      return;
    }
    let doc: ConfigDoc;
    try {
      doc = parseConfig(this.raw());
    } catch (e) {
      this.err.set('配置解析失败：' + errMsg(e));
      return;
    }
    const res = normalizeOutboundTags(doc);
    this.raw.set(JSON.stringify(doc.root, null, 2) + '\n');
    this.err.set('');
    this.fmtWarn.set(res.warnings);
    const bits: string[] = [];
    if (res.renamed.length) {
      // 改名里区分「变成大写」和「变成小写」，让摘要如实反映两类规则
      const up = res.renamed.filter((r) => r.to === r.to.toUpperCase() && r.to !== r.to.toLowerCase()).length;
      const lo = res.renamed.filter((r) => r.to === r.to.toLowerCase() && r.to !== r.to.toUpperCase()).length;
      const parts: string[] = [];
      if (up) parts.push(`分组 → 大写 ${up} 个`);
      if (lo) parts.push(`节点/端点 → 小写 ${lo} 个`);
      bits.push(parts.join('、') || `改大小写 ${res.renamed.length} 个 tag`);
    }
    if (res.merged.length) bits.push(`合并 ${res.merged.length} 个（${res.merged.map((m) => `${m.from}→${m.to}`).join('、')}）`);
    if (res.refs) bits.push(`同步 ${res.refs} 处引用`);
    this.log.set(
      bits.length
        ? '⇧ 格式化完成：' + bits.join(' · ') + '（只改暂存区，点「应用并重启」才写回路由）'
        : '⇧ 格式化完成：tag 大小写已符合规则（分组大写 / 节点小写），只整理了 JSON 缩进（未写回路由）',
    );
  }

  /** 撤销：丢弃全部暂存，回到最近一次读取的原文 */
  revert(): void {
    this.raw.set(this.original());
    this.fmtWarn.set([]);
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
      const ok = await this.ui.ask({
        title: `结构校验有 ${this.issues().length} 条问题，仍要应用并重启？`,
        details: this.issues().slice(0, 8),
        okText: '仍然应用',
        danger: true,
      });
      if (!ok) return;
    } else {
      const ok = await this.ui.ask({
        title: `把配置写回 ${this.host()} 并重启 sing-box？`,
        body: '断流约 1 秒，失败会自动回滚。',
        okText: '应用并重启',
      });
      if (!ok) return;
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
    const ok = await this.ui.ask({
      title: `重启 ${this.host()} 上的 sing-box？`,
      body: '断流约 1 秒，配置不改动。',
      okText: '重启',
    });
    if (!ok) return;
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

  // ---------- 节点：新增 / 编辑（弹窗见 node-create-dialog.ts）----------

  /** 打开「新增节点」弹窗（解析失败时拒绝：弹窗依赖结构化文档） */
  openNodeAdd(): void {
    if (!this.doc()) {
      this.err.set('当前配置无法解析，无法用表单编辑；请先修好 JSON');
      return;
    }
    this.nodeEditing.set(null);
    this.nodeDialog.set(true);
  }

  /** 打开「编辑节点」弹窗（按 tag 回填） */
  openNodeEdit(tag: string): void {
    if (!this.doc()) return;
    this.nodeEditing.set(tag);
    this.nodeDialog.set(true);
  }

  /** 弹窗产出新文档 → 暂存复核（与规则/看板同一条管线） */
  onNodeDoc(d: ConfigDoc): void {
    this.nodeDialog.set(false);
    this.enterReview(d);
  }

  /** 关闭节点弹窗 */
  closeNodeDialog(): void {
    this.nodeDialog.set(false);
  }

  // ---------- 删除（引用联动，见 config-ops.deleteImpact/deleteNode）----------

  /** 删除前先看引用影响（deleteImpact）：被 route 引用等情形直接拒绝；
   *  可删时列出分组移除/default 联动后果，确认后 deleteNode 并进暂存复核 */
  async askDelete(tag: string): Promise<void> {
    const d = this.doc();
    if (!d) return;
    const info = deleteImpact(d, tag);
    if (info.blocked) {
      this.err.set(`不能删除 ${tag}：` + info.reasons.join('；'));
      return;
    }
    const details = [
      info.groups.length ? `会从 ${info.groups.length} 个分组中移除：${info.groups.join('、')}` : '没有被任何分组引用',
      info.isDefault.length ? `这些组的 default 会改成第一个成员：${info.isDefault.map((x) => x.group).join('、')}` : '',
      '生成后先看 diff，再点「应用并重启」',
    ].filter(Boolean);
    const ok = await this.ui.ask({
      title: `删除节点 ${tag}？`,
      body: '先暂存到本页，点「应用并重启」才会写回路由。',
      details,
      okText: '删除（暂存）',
      danger: true,
    });
    if (!ok) return;
    try {
      deleteNode(d, tag);
      this.log.set(`已从配置中移除节点 ${tag}（尚未应用）`);
      this.enterReview(d);
    } catch (e) {
      this.err.set((e as Error).message);
    }
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
    const ok = await this.ui.ask({
      title: `删除 ${host} 的 SSH 凭据？`,
      body: '99 上这台路由的账号会被清掉，之后「应用并重启」会要求重新填写。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
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
}