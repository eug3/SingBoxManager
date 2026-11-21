import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** 文件通道（SMB/SFTP/本地）体检结果 */
interface FilePart {
  mode: string;
  ok: boolean;
  detail: string;
  files: number;
  sample: string;
  size: number;
  mtime?: string;
  error?: string;
  ms: number;
}

/** 公网只读 HTTP 通道体检结果 */
interface HttpPart {
  url: string;
  ok: boolean;
  status: number;
  mtime?: string;
  size: number;
  ms: number;
  error?: string;
}

export interface ShareHealth {
  ok: boolean;
  file: FilePart;
  http: HttpPart;
  public: string;
  page: string;
}

/**
 * 顶栏状态点的数据源：**只检查文件通道与公网读取 URL**，与路由 sing-box 配置无关。
 *   1. 文件通道 —— 99 用纯 Go SMB2（或 SFTP/本地目录）直接读 NAS 桶目录，不依赖 cifs 挂载；
 *   2. 公网 URL —— 用公网域名把样本 .srs 拉一遍，确认对外只读链路真的通。
 * 每 30 秒自动体检一次，点状态点可立即重测。
 */
@Injectable({ providedIn: 'root' })
export class ShareHealthService {
  private readonly httpClient = inject(HttpClient);
  readonly health = signal<ShareHealth | null>(null);
  readonly busy = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 开始周期体检（App 启动时调用一次） */
  start(intervalMs = 30000): void {
    void this.probe();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.probe(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 立即体检一次 */
  async probe(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const h = await firstValueFrom(this.httpClient.get<ShareHealth>('/share/health'));
      this.health.set(h);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.health.set({
        ok: false,
        file: { mode: '—', ok: false, detail: '', files: 0, sample: '', size: 0, ms: 0, error: msg },
        http: { url: '', ok: false, status: 0, size: 0, ms: 0, error: msg },
        public: '',
        page: '',
      });
    } finally {
      this.busy.set(false);
    }
  }
}