import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BackendsService } from './backends.service';
import { CachedVersion } from './version.service';
import { AnyObj } from './config-ops';

/** 一台受管 VPS 的台账（密码只写不读，GET 回来是掩码） */
export interface VpsItem {
  host: string;
  name: string;
  user: string;
  password?: string;
  port: number;
  sni: string;
  listenPort: number;
  addrPool: string;
  certMode: 'self' | 'existing' | string;
  certPath: string;
  keyPath: string;
  version: string;
  state: 'new' | 'deployed' | 'failed' | string;
  lastDeployAt: string;
  lastError: string;
  lastLog: string;
  nodeJson: string;
  updatedAt: string;
}

/** 表单请求体（Password 空 = 沿用已存的） */
export interface VpsReq {
  host: string;
  name: string;
  user: string;
  password: string;
  port: number;
  sni: string;
  listenPort: number;
  addrPool: string;
  certMode: string;
  certPath: string;
  keyPath: string;
  version: string;
}

export interface VpsProbe {
  arch: string;
  libc: string;
  root: boolean;
  hasSystemd: boolean;
  portInUse: boolean;
  os: string;
  existing: boolean;
  existingVer: string;
  raw?: string;
}

export interface VpsListResp {
  ok: boolean;
  items: VpsItem[];
  cache: CachedVersion[];
  nextAddrPool: string;
}

export interface VpsPreviewResp {
  ok: boolean;
  host: string;
  tag: string;
  config: string;
  script: string;
  probe: string;
  note: string;
}

export interface VpsDeployResp {
  ok: boolean;
  host: string;
  tag: string;
  version?: string;
  secs?: number;
  error?: string;
  log?: string;
  probe?: VpsProbe;
  binary?: { version: string; arch: string; variant: string; sizeMB: number };
  node?: AnyObj;
}

/** /vps/* 接口客户端（与 version.service 同源：取全局 key，99 侧校验） */
@Injectable({ providedIn: 'root' })
export class VpsService {
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);

  private headers(): HttpHeaders {
    const list = this.backends.backends();
    const key = this.backends.globalKey() || (list.length ? this.backends.keyFor(list[0]) : '');
    return key
      ? new HttpHeaders({ 'X-Vault-Key': key, 'Content-Type': 'application/json' })
      : new HttpHeaders({ 'Content-Type': 'application/json' });
  }

  list(): Promise<VpsListResp> {
    return firstValueFrom(this.http.get<VpsListResp>('/vps/list', { headers: this.headers() }));
  }

  save(req: VpsReq): Promise<{ ok: boolean; item: VpsItem }> {
    return firstValueFrom(this.http.post<{ ok: boolean; item: VpsItem }>('/vps/save', req, { headers: this.headers() }));
  }

  remove(host: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.delete<{ ok: boolean }>('/vps', { headers: this.headers(), params: { host } }),
    );
  }

  preview(req: VpsReq): Promise<VpsPreviewResp> {
    return firstValueFrom(this.http.post<VpsPreviewResp>('/vps/preview', req, { headers: this.headers() }));
  }

  probe(req: VpsReq): Promise<{ ok: boolean; probe: VpsProbe }> {
    return firstValueFrom(this.http.post<{ ok: boolean; probe: VpsProbe }>('/vps/probe', req, { headers: this.headers() }));
  }

  deploy(req: VpsReq): Promise<VpsDeployResp> {
    return firstValueFrom(this.http.post<VpsDeployResp>('/vps/deploy', req, { headers: this.headers() }));
  }
}
