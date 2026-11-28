import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { VpsDeployResp, VpsItem, VpsPreviewResp, VpsProbe, VpsReq, VpsService } from './vps.service';
import { SharedPoolService } from './shared-pool.service';
import { buildPoolNode } from './vps-model';
import { CachedVersion } from './version.service';
import { errMsg } from './util';
import { ConfirmService } from './confirm.service';

/** 空表单（默认值：443 / 自动地址池由后端补） */
function blankForm(addrPool: string): VpsReq {
  return {
    host: '', name: '', user: 'root', password: '', port: 22,
    sni: '', listenPort: 443, addrPool, certMode: 'self',
    certPath: '', keyPath: '', version: '',
  };
}

/**
 * 「远程 VPS」tab —— 管理 VPS 台账，一键部署 sing-box masque server。
 *
 * 流程：填主机/凭据 → 保存台账 → 探测（只读）→ 预览脚本（dry-run，不连）→ 部署
 * → 成功后端回 masque-client endpoint → 自动写进共享节点池（kind=endpoint）。
 *
 * 部署是**破坏性**操作（远端装二进制、写 systemd、起服务），所以：
 *  · 必须先「预览」看过脚本，部署按钮才可用；
 *  · 部署前弹确认框，写明目标主机与端口；
 *  · 远端配置会先备份，sing-box check 不过就停（不影响远端现状）。
 */
@Component({
  selector: 'app-vps-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JsonPipe],
  templateUrl: './vps-pane.html',
})
export class VpsPane implements OnInit {
  private readonly svc = inject(VpsService);
  private readonly pool = inject(SharedPoolService);
  private readonly ui = inject(ConfirmService);

  readonly items = signal<VpsItem[]>([]);
  readonly cache = signal<CachedVersion[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly err = signal('');
  readonly note = signal('');

  readonly form = signal<VpsReq>(blankForm(''));
  readonly selectedHost = signal('');
  readonly probeRes = signal<VpsProbe | null>(null);
  readonly previewRes = signal<VpsPreviewResp | null>(null);
  readonly deployRes = signal<VpsDeployResp | null>(null);
  readonly previewOpen = signal(false);
  /** 本次表单是否已经预览过（未预览不允许部署） */
  readonly previewed = signal(false);
  /** 部署成功后的入池结果提示 */
  readonly poolMsg = signal('');
  readonly showLog = signal(false);

  readonly canDeploy = computed(() => this.previewed() && !this.busy() && !!this.form().host.trim());
  readonly deployedCount = computed(() => this.items().filter((i) => i.state === 'deployed').length);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.err.set('');
    try {
      const r = await this.svc.list();
      this.items.set(r.items ?? []);
      this.cache.set(r.cache ?? []);
      const cur = this.form();
      if (!cur.addrPool && r.nextAddrPool) this.form.set({ ...cur, addrPool: r.nextAddrPool });
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** 选中台账里的一台，填进表单（密码留空 = 沿用） */
  pick(v: VpsItem): void {
    this.selectedHost.set(v.host);
    this.form.set({
      host: v.host, name: v.name, user: v.user, password: '', port: v.port,
      sni: v.sni, listenPort: v.listenPort, addrPool: v.addrPool, certMode: v.certMode,
      certPath: v.certPath, keyPath: v.keyPath, version: v.version,
    });
    this.probeRes.set(null);
    this.previewRes.set(null);
    this.deployRes.set(null);
    this.previewed.set(false);
    this.poolMsg.set('');
    this.err.set('');
    this.note.set('');
  }

  newVps(): void {
    this.selectedHost.set('');
    this.form.set(blankForm(this.form().addrPool));
    this.probeRes.set(null);
    this.previewRes.set(null);
    this.deployRes.set(null);
    this.previewed.set(false);
    this.poolMsg.set('');
    this.err.set('');
    this.note.set('');
  }

  patch(p: Partial<VpsReq>): void {
    this.form.set({ ...this.form(), ...p });
    // 任何字段改动都让「已预览」失效（防止改了参数直接部署）
    if (this.previewed()) {
      this.previewed.set(false);
      this.note.set('参数已改动，请重新预览后再部署');
    }
  }

  num(v: string, dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  }

  /** 保存台账（不连远端） */
  async save(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    try {
      const r = await this.svc.save(this.form());
      this.selectedHost.set(r.item.host);
      this.note.set('台账已保存');
      await this.load();
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 探测：只读，不改远端 */
  async probe(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    this.probeRes.set(null);
    try {
      const r = await this.svc.probe(this.form());
      this.probeRes.set(r.probe);
      this.note.set('探测完成（只读）');
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 预览：不连远端，只看将要执行的配置与脚本 */
  async preview(): Promise<void> {
    this.busy.set(true);
    this.err.set('');
    try {
      const r = await this.svc.preview(this.form());
      this.previewRes.set(r);
      this.previewOpen.set(true);
      this.previewed.set(true);
      this.note.set('已生成部署方案：确认脚本无误后点「部署」');
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** 部署：真改远端 */
  async deploy(): Promise<void> {
    if (!this.canDeploy()) return;
    const f = this.form();
    const ok = await this.ui.ask({
      title: `在 ${f.host} 上部署 masque server？`,
      body: `会安装 ${f.user === 'root' ? 'root' : f.user} 名下的 sing-box、写 systemd 单元并启动 `
        + `sing-box-masque（UDP ${f.listenPort}）。远端已有配置会先备份；check 不通过会自动中止。`,
      okText: '开始部署',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    this.err.set('');
    this.deployRes.set(null);
    this.poolMsg.set('');
    this.showLog.set(false);
    try {
      const r = await this.svc.deploy(f);
      this.deployRes.set(r);
      if (r.ok && r.node) this.addToPool(r);
      await this.load();
    } catch (e) {
      // 后端失败会带 body（error/log/probe），尽量显示出来
      const body = (e as { error?: VpsDeployResp })?.error;
      if (body && typeof body === 'object') {
        this.deployRes.set(body);
        this.err.set(body.error || '部署失败');
      } else {
        this.err.set(errMsg(e));
      }
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** 部署成功 → 自动写进共享节点池（tag 冲突自动改名） */
  private addToPool(r: VpsDeployResp): void {
    const item = this.items().find((i) => i.host === r.host);
    const srcApi = 'vps:' + r.host;
    const taken = this.pool.nodes().filter((n) => n.sourceApi !== srcApi).map((n) => n.tag);
    const built = buildPoolNode(r.host, r.node, taken);
    if (!built.ok) {
      this.poolMsg.set('未能入池：' + (built.reason ?? '未知原因'));
      return;
    }
    const add = this.pool.addNode(
      { api: srcApi, name: 'VPS ' + (item?.name || r.host) },
      built.node!,
      'endpoint',
    );
    if (!add.ok) {
      this.poolMsg.set('入池失败：' + (add.reason ?? '未知原因'));
      return;
    }
    this.poolMsg.set(
      built.renamed
        ? `已加入共享节点池（tag 与其它来源冲突，已改名为 ${built.tag}）`
        : `已加入共享节点池：${built.tag}（kind=endpoint）`,
    );
  }

  /** 删除台账（不动远端），二次确认 */
  async remove(v: VpsItem): Promise<void> {
    const ok = await this.ui.ask({
      title: `从台账删除 ${v.name || v.host}？`,
      body: '只删控制台里的记录，**不会**卸载远端服务；远端 sing-box-masque 会继续运行。',
      okText: '删除记录',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await this.svc.remove(v.host);
      if (this.selectedHost() === v.host) this.newVps();
      await this.load();
      this.note.set('台账记录已删除（远端未动）');
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  stateLabel(s: string): string {
    switch (s) {
      case 'deployed': return '已部署';
      case 'failed': return '失败';
      default: return '未部署';
    }
  }

  /** 从 99 缓存里挑出给这台机器用的候选包（按表单版本过滤） */
  readonly cacheHint = computed(() => {
    const list = this.cache();
    if (!list.length) return '99 上还没有缓存任何 sing-box 包（先去「⤓ 版本管理」下载）';
    return `99 已缓存 ${list.length} 个包：` + list.slice(0, 6).map((c) => `${c.version}${c.variant ? '/' + c.variant : ''}/${c.arch}`).join('、')
      + (list.length > 6 ? ' …' : '');
  });
}