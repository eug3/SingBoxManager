import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Backend } from './models';
import { BackendsService } from './backends.service';

export interface RouterConfigResp {
  ok: boolean;
  host: string;
  name?: string;
  config: string;
  size: number;
  sha256: string;
  ms: number;
}

export interface RouterOpResp {
  ok: boolean;
  changed?: boolean;
  host: string;
  log: string;
  ms: number;
}

export interface RouterCredInfo {
  host: string;
  name?: string;
  user: string;
  port?: number;
  configured?: boolean;
}

export interface RouterCredsResp {
  ok: boolean;
  hosts: RouterCredInfo[];
  allow: string[];
  file?: string;
}

export interface RouterCheckResp {
  ok: boolean;
  host: string;
  output: string;
}

/**
 * 99 的 vault-edit 路由配置通道客户端。
 * 服务端在 99 侧编排（SSH 上传候选配置 + 内联脚本），路由无需预装任何东西。
 * 鉴权头 X-Vault-Key 直接用该后端的 clash 密钥（服务端认 VAULT_KEY 或 clash secret）。
 */
@Injectable({ providedIn: 'root' })
export class RouterService {
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);

  /** 99 接口鉴权用的密钥：优先该后端的 clash 密钥，其次全局密钥 */
  private headers(b?: Backend): HttpHeaders {
    const key = b ? this.backends.keyFor(b) : this.backends.globalKey();
    return new HttpHeaders({ 'X-Vault-Key': key });
  }

  host(b: Backend): string {
    try {
      return new URL(b.api).hostname;
    } catch {
      return b.api;
    }
  }

  config(b: Backend): Promise<RouterConfigResp> {
    return firstValueFrom(
      this.http.get<RouterConfigResp>('/router/config', {
        headers: this.headers(b),
        params: { host: this.host(b) },
      }),
    );
  }

  restart(b: Backend): Promise<RouterOpResp> {
    return firstValueFrom(
      this.http.post<RouterOpResp>('/router/restart', { host: this.host(b) }, { headers: this.headers(b) }),
    );
  }

  check(b: Backend, config: string): Promise<RouterCheckResp> {
    return firstValueFrom(
      this.http.post<RouterCheckResp>(
        '/router/check',
        { host: this.host(b), config },
        { headers: this.headers(b) },
      ),
    );
  }

  credentials(b: Backend): Promise<RouterCredsResp> {
    return firstValueFrom(this.http.get<RouterCredsResp>('/router/credentials', { headers: this.headers(b) }));
  }

  setCredentials(b: Backend, host: string, user: string, password: string, name?: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(
        '/router/credentials',
        { host, user, password, name },
        { headers: this.headers(b) },
      ),
    );
  }

  deleteCredentials(b: Backend, host: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.delete<{ ok: boolean }>('/router/credentials', { headers: this.headers(b), params: { host } }),
    );
  }

  apply(b: Backend, config: string, expectSha: string): Promise<RouterOpResp> {
    return firstValueFrom(
      this.http.post<RouterOpResp>(
        '/router/apply',
        { host: this.host(b), config, expectSha },
        { headers: this.headers(b) },
      ),
    );
  }
}