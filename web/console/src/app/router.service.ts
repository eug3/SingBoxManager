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

/** 99 的 vault-edit 代理：受限 SSH → 路由器本地 singbox-apply 脚本 */
@Injectable({ providedIn: 'root' })
export class RouterService {
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);

  private headers(): HttpHeaders {
    return new HttpHeaders({ 'X-Vault-Key': this.backends.globalKey() });
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
        headers: this.headers(),
        params: { host: this.host(b) },
      }),
    );
  }

  restart(b: Backend): Promise<RouterOpResp> {
    return firstValueFrom(
      this.http.post<RouterOpResp>('/router/restart', { host: this.host(b) }, { headers: this.headers() }),
    );
  }

  check(b: Backend, config: string): Promise<RouterCheckResp> {
    return firstValueFrom(
      this.http.post<RouterCheckResp>(
        '/router/check',
        { host: this.host(b), config },
        { headers: this.headers() },
      ),
    );
  }

  credentials(): Promise<RouterCredsResp> {
    return firstValueFrom(this.http.get<RouterCredsResp>('/router/credentials', { headers: this.headers() }));
  }

  setCredentials(host: string, user: string, password: string, name?: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/router/credentials', { host, user, password, name }, { headers: this.headers() }),
    );
  }

  deleteCredentials(host: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.delete<{ ok: boolean }>('/router/credentials', { headers: this.headers(), params: { host } }),
    );
  }

  apply(b: Backend, config: string, expectSha: string): Promise<RouterOpResp> {
    return firstValueFrom(
      this.http.post<RouterOpResp>(
        '/router/apply',
        { host: this.host(b), config, expectSha },
        { headers: this.headers() },
      ),
    );
  }
}