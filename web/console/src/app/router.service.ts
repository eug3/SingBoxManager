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