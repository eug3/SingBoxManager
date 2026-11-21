import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Backend } from './models';
import { RouterService } from './router.service';
import { errMsg } from './util';

/**
 * SSH 凭据弹窗 — 「保存并重启」发现 99 上没配这台路由的 SSH 账号时弹出。
 *
 * 表单：用户名（默认 root）/ 口令（type=password，不回显）/ 端口（默认 22，可选）。
 * 提交调 router.setCredentials(backend, host, user, password, name)（host 取
 * router.host(backend)）；凭据只提交给 99 落盘（0600），不存浏览器，提交后立刻
 * 从页面内存清掉口令。成功 → output saved → backend-pane 关窗并自动重试 save。
 *
 * 注意：服务端 POST /router/credentials 支持 port 字段，但现有客户端
 * router.service.setCredentials 不传 port（该文件禁改）——非 22 端口这里如实
 * 提示「暂按 22 保存」，需要自定义端口时得先给 setCredentials 加参数。
 */
@Component({
  selector: 'app-ssh-cred-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './ssh-cred-dialog.html',
})
export class SshCredDialog implements OnInit {
  readonly backend = input.required<Backend>();
  /** 凭据保存成功（backend-pane 据此关窗并重试「保存并重启」） */
  readonly saved = output<void>();
  /** 用户主动关闭（取消） */
  readonly closed = output<void>();

  private readonly router = inject(RouterService);

  readonly host = computed(() => this.router.host(this.backend()));

  readonly user = signal('root');
  readonly password = signal('');
  readonly port = signal('22');
  readonly busy = signal(false);
  readonly err = signal('');
  /** 99 上已有该 host 的凭据（重新提交 = 覆盖） */
  readonly configured = signal(false);

  /** 非 22 端口的如实提示（客户端 setCredentials 目前不传 port） */
  readonly portNote = computed(() =>
    this.port().trim() !== '22'
      ? '当前凭据接口客户端不传端口参数：服务端会按 22 保存，自定义端口暂不生效'
      : '',
  );

  ngOnInit(): void {
    // 预填已有凭据的 user/port（口令绝不回显）；清单拉不到也不挡表单
    void this.loadInfo();
  }

  private async loadInfo(): Promise<void> {
    try {
      const res = await this.router.credentials(this.backend());
      const me = (res?.hosts ?? []).find((h) => h.host === this.host());
      if (me) {
        if (me.user) this.user.set(me.user);
        if (me.port) this.port.set(String(me.port));
        this.configured.set(me.configured === true);
      }
    } catch {
      /* 预填失败不影响手填提交 */
    }
  }

  async submit(): Promise<void> {
    const user = this.user().trim();
    const pw = this.password();
    if (!user || !pw) {
      this.err.set('用户名与口令都不能为空');
      return;
    }
    const p = Number(this.port().trim() || '22');
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      this.err.set('端口必须是 1–65535 的整数');
      return;
    }
    this.busy.set(true);
    this.err.set('');
    try {
      await this.router.setCredentials(this.backend(), this.host(), user, pw, this.backend().name);
      this.password.set(''); // 口令只经过一次，立刻从页面内存清掉
      this.saved.emit();
    } catch (e) {
      this.err.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    this.password.set('');
    this.closed.emit();
  }

  /** 点遮罩空白处关闭（点弹窗本体不关） */
  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}