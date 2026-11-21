import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BackendsService } from './backends.service';
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

/** 存储配置（与后端 ShareConfig 对齐） */
export interface ShareConfigPayload {
  mode: 'smb' | 'sftp' | 'local';
  smb: { addr: string; share: string; path: string; user: string; pass: string; domain: string };
  sftp: { addr: string; user: string; pass: string; key: string; path: string };
  local: { dir: string };
  publicBase: string;
  /** 只读文件服务的独立端口（管理台不跟着暴露），如 :9098；空=不启用 */
  filesListen: string;
  sample: string;
}

/** GET /share/config 的回显（口令只给 passSet 标记） */
export interface ShareConfigEcho extends Omit<ShareConfigPayload, 'smb' | 'sftp'> {
  smb: Omit<ShareConfigPayload['smb'], 'pass'> & { passSet: boolean };
  sftp: Omit<ShareConfigPayload['sftp'], 'pass'> & { passSet: boolean };
  file: string;
}

/** 一次体检结果（/share/health 与 /share/probe 同结构） */
export interface ShareProbe extends ShareHealth {
  mode?: string;
  localDir?: string;
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
  private readonly bsvc = inject(BackendsService);

  /** 配置类接口要带鉴权头（和服务端 /router/* 同一把钥匙：clash 密钥 / 全局密钥） */
  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ 'X-Vault-Key': this.bsvc.globalKey() });
  }
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

  /** 读当前存储配置 */
  async configGet(): Promise<ShareConfigEcho> {
    const r = await firstValueFrom(
      this.httpClient.get<{ config: ShareConfigEcho }>('/share/config', { headers: this.authHeaders() }),
    );
    return r.config;
  }

  /** 保存并立即生效（服务端热替换，无需重启） */
  async configSave(cfg: ShareConfigPayload): Promise<{ fileOK: boolean; files?: number; mode: string; fileError?: string }> {
    return firstValueFrom(
      this.httpClient.post<{ fileOK: boolean; files?: number; mode: string; fileError?: string }>(
        '/share/config',
        { config: cfg },
        { headers: this.authHeaders() },
      ),
    );
  }

  /** 用候选配置试连（不落盘） */
  async probeWith(cfg: ShareConfigPayload): Promise<ShareProbe> {
    return firstValueFrom(
      this.httpClient.post<ShareProbe>('/share/probe', { config: cfg }, { headers: this.authHeaders() }),
    );
  }

  /** 把当前共享的桶文件复制到本机 local 目录 */
  async importToLocal(): Promise<{ copied: number; skipped: number; dir: string }> {
    return firstValueFrom(
      this.httpClient.post<{ copied: number; skipped: number; dir: string }>('/share/import', {}, { headers: this.authHeaders() }),
    );
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