import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Backend } from './models';
import { BackendsService } from './backends.service';

/** GET /router/apistatus 响应：sing-box API 服务（gRPC 9092）里的运行时信息 */
export interface RouterApiStatus {
  ok: boolean;
  host?: string;
  /** started / stopped */
  state?: string;
  /** 原样串，如 1h53m3s */
  uptime?: string;
  /** 解析后的秒数 */
  uptimeSec?: number;
  memoryMB?: number;
  /** Go 协程数（clash_api 没有） */
  goroutines?: number;
  /** 入站 / 出站连接数（clash_api 只有合并值） */
  connIn?: number;
  connOut?: number;
  upRate?: string;
  downRate?: string;
  upTotal?: string;
  downTotal?: string;
  groups?: number;
  nodes?: number;
  /** 分组 tag → 当前选中成员 */
  selected?: Record<string, string>;
  version?: string;
  mode?: string;
  /** 能力不可用时的原因（如路由未启用 service/api） */
  err?: string;
}

/** GET /router/config 响应：整份 config.json 文本 + 大小 + sha256（乐观锁基准） */
export interface RouterConfigResp {
  ok: boolean;
  host: string;
  name?: string;
  config: string;
  size: number;
  sha256: string;
  ms: number;
}

/** apply/restart 响应：changed=是否真的改写/重启，log=远端编排日志 */
export interface RouterOpResp {
  ok: boolean;
  changed?: boolean;
  host: string;
  log: string;
  ms: number;
}

/** 单台路由的 SSH 凭据回显（口令不回传，configured=是否已设口令） */
export interface RouterCredInfo {
  host: string;
  name?: string;
  user: string;
  port?: number;
  configured?: boolean;
}

/** GET /router/credentials 响应：凭据名册 + 允许 host 白名单 */
export interface RouterCredsResp {
  ok: boolean;
  hosts: RouterCredInfo[];
  allow: string[];
  file?: string;
}

/** POST /router/check 响应：sing-box check 的输出（ok=校验通过） */
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

  /** 从后端 api URL 取 hostname（作为 /router/* 的 host 参数）；解析失败退回原串 */
  host(b: Backend): string {
    try {
      return new URL(b.api).hostname;
    } catch {
      return b.api;
    }
  }

  /** 读路由当前 config.json（99 经 SSH cat） */
  config(b: Backend): Promise<RouterConfigResp> {
    return firstValueFrom(
      this.http.get<RouterConfigResp>('/router/config', {
        headers: this.headers(b),
        params: { host: this.host(b) },
      }),
    );
  }

  /** sing-box API 服务的运行状态（运行时长 / 协程 / 入出连接数；clash_api 无法提供） */
  apiStatus(b: Backend): Promise<RouterApiStatus> {
    return firstValueFrom(
      this.http.get<RouterApiStatus>('/router/apistatus', {
        headers: this.headers(b),
        params: { host: this.host(b) },
      }),
    );
  }

  /** 重启路由 sing-box（约 1–2s 断流） */
  restart(b: Backend): Promise<RouterOpResp> {
    return firstValueFrom(
      this.http.post<RouterOpResp>('/router/restart', { host: this.host(b) }, { headers: this.headers(b) }),
    );
  }

  /** 远端 sing-box check 校验候选配置（不写盘） */
  check(b: Backend, config: string): Promise<RouterCheckResp> {
    return firstValueFrom(
      this.http.post<RouterCheckResp>(
        '/router/check',
        { host: this.host(b), config },
        { headers: this.headers(b) },
      ),
    );
  }

  /** 读 SSH 凭据名册（保存前预检是否缺凭据） */
  credentials(b: Backend): Promise<RouterCredsResp> {
    return firstValueFrom(this.http.get<RouterCredsResp>('/router/credentials', { headers: this.headers(b) }));
  }

  /** 写入某 host 的 SSH 凭据（0600 存 SQLite）；注意当前不传 port */
  setCredentials(b: Backend, host: string, user: string, password: string, name?: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(
        '/router/credentials',
        { host, user, password, name },
        { headers: this.headers(b) },
      ),
    );
  }

  /** 删除某 host 的 SSH 凭据 */
  deleteCredentials(b: Backend, host: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.delete<{ ok: boolean }>('/router/credentials', { headers: this.headers(b), params: { host } }),
    );
  }

  /** 应用候选配置：expectSha 乐观锁（不一致→409 STALE）；服务端备份→check→替换→重启→健康→回滚 */
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