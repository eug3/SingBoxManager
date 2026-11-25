import { Injectable, computed, inject, signal } from '@angular/core';
import { Backend } from './models';
import { RouterService } from './router.service';
import { ConfigDoc, parseConfig, serializeConfig } from './config-ops';
import { errMsg } from './util';

/** 错误文案里出现这些特征 = 缺 SSH 凭据 / 凭据不对（与 config-pane 连接门禁同一口径） */
const CRED_ERR = /凭据|Permission denied|ssh/i;

/**
 * ConfigDraftService — 流向图编辑（③ 规则集 / ④ 分组弹窗）的全局配置草稿。
 *
 * 数据流：
 *   load(backend) 拉 /router/config → originalText + originalSha + baseDoc（只读基准）；
 *   弹窗克隆「当前草稿（没有则 baseDoc）」改完 → stage(doc) 暂存；
 *   dirty = draft != null → backend-pane 顶部「待保存条」跨子 tab 可见；
 *   save(backend) 先查 SSH 凭据（缺 → needCreds，页面弹凭据框），
 *   再 serializeConfig(draft, originalText) 按原文缩进/行尾写回 →
 *   router.apply（99 编排：备份/check/替换/重启/失败回滚，expectSha 乐观锁）→
 *   成功后清 draft 并重新 load（拿到新 sha）。
 *
 * 草稿只在内存：取消 / 刷新即消失，与「配置」页的暂存互不相干。
 */
@Injectable({ providedIn: 'root' })
export class ConfigDraftService {
  private readonly router = inject(RouterService);

  /** 最近一次从路由读到的原文（serializeConfig 的缩进/行尾基准） */
  readonly originalText = signal('');
  /** 原文 sha256（apply 的 expectSha 乐观锁） */
  readonly originalSha = signal('');
  /** 原文解析出的结构化文档（弹窗编辑的基准；解析失败为 null） */
  readonly baseDoc = signal<ConfigDoc | null>(null);
  /** 暂存中的修改稿（null = 没有未保存改动） */
  readonly draft = signal<ConfigDoc | null>(null);
  /** 有暂存改动（待保存条的开关） */
  readonly dirty = computed(() => this.draft() !== null);

  readonly loading = signal(false);
  readonly saving = signal(false);
  /** 最近一次 load/save 的错误文案（待保存条 / 弹窗里展示） */
  readonly error = signal('');
  /** 非致命警告：配置已写回成功、但保存后的「重读基准」失败（网络抖动/链路瞬断） */
  readonly warn = signal('');
  /** save 被「缺 SSH 凭据」挡住：backend-pane 据此打开凭据弹窗，填完重试 */
  readonly needCreds = signal(false);

  /** 拉一次配置作为编辑基准；顺带清掉旧草稿（后端切换 / 保存成功后都走这里） */
  async load(backend: Backend): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.warn.set('');
    this.needCreds.set(false);
    this.draft.set(null);
    try {
      const resp = await this.router.config(backend);
      const text = resp?.config ?? '';
      this.originalText.set(text);
      this.originalSha.set(resp?.sha256 ?? '');
      try {
        this.baseDoc.set(parseConfig(text));
      } catch {
        this.baseDoc.set(null); // JSON 坏掉：弹窗不可用，但不影响流向渲染
      }
    } catch (e) {
      this.baseDoc.set(null);
      this.error.set(errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** 暂存一份新文档（弹窗每次改动都调；不写回路由） */
  stage(doc: ConfigDoc): void {
    this.draft.set(doc);
    this.error.set('');
    this.warn.set('');
  }

  /** 放弃全部暂存改动 */
  cancel(): void {
    this.draft.set(null);
    this.error.set('');
    this.needCreds.set(false);
  }

  /**
   * 保存并重启：凭据预检 → apply（expectSha 乐观锁）→ 成功后清草稿并重读。
   * 缺凭据时不 apply，置 needCreds 让页面弹 SSH 凭据框；apply 报错且文案
   * 含「凭据 / Permission denied / ssh」同样置 needCreds（凭据可能已失效）。
   */
  async save(backend: Backend): Promise<void> {
    const doc = this.draft();
    if (!doc || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.warn.set('');
    this.needCreds.set(false);
    try {
      // 凭据预检：99 上没配这台 host 的 SSH 账号/口令就别白跑 apply
      try {
        const creds = await this.router.credentials(backend);
        const host = this.router.host(backend);
        const me = (creds?.hosts ?? []).find((h) => h.host === host);
        if (!me || !me.user || me.configured === false) {
          this.needCreds.set(true);
          this.error.set(`未配置 ${host} 的 SSH 凭据：请先填写用户名与口令，保存后会自动重试`);
          return;
        }
      } catch {
        /* 凭据清单接口本身失败（如密钥错）不在这儿拦，交给 apply 报真实错误 */
      }
      const text = serializeConfig(doc, this.originalText());
      await this.router.apply(backend, text, this.originalSha());
      this.draft.set(null);
      await this.refreshAfterSave(backend); // 重新拉基准（新 sha），待保存条随之消失
    } catch (e) {
      const msg = errMsg(e);
      this.error.set(msg);
      if (CRED_ERR.test(msg)) this.needCreds.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * 保存成功后的「重读基准」：/router/config 偶发失败（浏览器 status 0 = 链路瞬断、
   * 99 到路由的 SSH 抖动）不代表没写成功 —— apply 已经返回且健康检查通过。
   * 这里重试 3 次；仍失败就把 error 降级成 warn，避免把「已生效」误报成「保存失败」。
   */
  private async refreshAfterSave(backend: Backend): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.load(backend);
      if (!this.error()) return;
      if (i < 2) await new Promise((r) => setTimeout(r, 500 + i * 900));
    }
    const msg = this.error();
    this.error.set('');
    this.warn.set(`配置已写回并重启成功，但刷新配置失败（${msg || '未知错误'}）：点顶部「刷新」重新读取即可。`);
  }
}