import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Backend, ConnectionsResp, ProxiesResp, RulesResp } from './models';
import { BackendsService } from './backends.service';

/**
 * clash_api 客户端 — 浏览器直连路由的 9090 端口（REST + WebSocket）。
 * 鉴权：REST 用 Authorization: Bearer；WebSocket 用 ?token=（sing-box 只认 query）。
 * 路由侧 CORS 白名单需包含本页来源（192.168.31.99:9099 / 10.1.1.99:9099）。
 */
@Injectable({ providedIn: 'root' })
export class ClashService {
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);

  /** 去掉 api 末尾斜杠，拼 REST 路径用 */
  private base(b: Backend): string {
    return (b.api || '').replace(/\/+$/, '');
  }

  /** REST 鉴权头：Bearer = 该后端 clash 密钥（空则全局） */
  private headers(b: Backend): HttpHeaders {
    return new HttpHeaders({ Authorization: 'Bearer ' + this.backends.keyFor(b) });
  }

  /** 引擎版本（/version，也用作连通性/密钥探针） */
  version(b: Backend): Promise<{ version: string }> {
    return firstValueFrom(this.http.get<{ version: string }>(`${this.base(b)}/version`, { headers: this.headers(b) }));
  }

  /** 全部出站/分组（含 history 测速记录，供延时点） */
  proxies(b: Backend): Promise<ProxiesResp> {
    return firstValueFrom(this.http.get<ProxiesResp>(`${this.base(b)}/proxies`, { headers: this.headers(b) }));
  }

  /** 活跃连接快照（chains/rule/累计字节，供流向图与活跃度） */
  connections(b: Backend): Promise<ConnectionsResp> {
    return firstValueFrom(this.http.get<ConnectionsResp>(`${this.base(b)}/connections`, { headers: this.headers(b) }));
  }

  /** 路由规则列表（/rules） */
  rules(b: Backend): Promise<RulesResp> {
    return firstValueFrom(this.http.get<RulesResp>(`${this.base(b)}/rules`, { headers: this.headers(b) }));
  }

  /** 切换 Selector 组成员（sing-box 只接受 Selector，URLTest 会返回 400） */
  select(b: Backend, group: string, member: string): Promise<unknown> {
    return firstValueFrom(
      this.http.put(`${this.base(b)}/proxies/${encodeURIComponent(group)}`, { name: member }, { headers: this.headers(b) }),
    );
  }

  /** 测单个节点延迟（毫秒；失败时 sing-box 返回 {delay:0} 或非 2xx） */
  async delay(b: Backend, name: string): Promise<number> {
    const params = new HttpParams().set('timeout', '3000').set('url', 'http://www.gstatic.com/generate_204');
    const resp = await firstValueFrom(
      this.http.get<{ delay: number }>(`${this.base(b)}/proxies/${encodeURIComponent(name)}/delay`, {
        headers: this.headers(b),
        params,
      }),
    );
    return resp?.delay ?? 0;
  }

  /** 断开单条连接 */
  kill(b: Backend, id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`${this.base(b)}/connections/${encodeURIComponent(id)}`, { headers: this.headers(b) }));
  }

  /** 断开全部连接 */
  killAll(b: Backend): Promise<unknown> {
    return firstValueFrom(this.http.delete(`${this.base(b)}/connections`, { headers: this.headers(b) }));
  }

  /** 任意 WebSocket 端点（/traffic /memory /connections /logs，token 走 query） */
  wsUrl(b: Backend, path: string, extra?: Record<string, string>): string {
    const host = new URL(this.base(b)).host;
    const q = new URLSearchParams({ token: this.backends.keyFor(b), ...(extra ?? {}) });
    return `ws://${host}${path}?${q.toString()}`;
  }

  /** 当前运行配置（sing-box 只回 mode / mode-list / log-level 等只读字段） */
  configs(b: Backend): Promise<{ mode?: string; 'mode-list'?: string[]; 'log-level'?: string }> {
    return firstValueFrom(
      this.http.get<{ mode?: string; 'mode-list'?: string[]; 'log-level'?: string }>(`${this.base(b)}/configs`, {
        headers: this.headers(b),
      }),
    );
  }

  /** 切换路由模式（sing-box 唯一支持写入的运行时字段） */
  setMode(b: Backend, mode: string): Promise<unknown> {
    return firstValueFrom(this.http.patch(`${this.base(b)}/configs`, { mode }, { headers: this.headers(b) }));
  }

  /** 日志 WebSocket 地址（token 走 query，sing-box 只认这种方式） */
  logsUrl(b: Backend, level: string): string {
    const host = new URL(this.base(b)).host;
    return `ws://${host}/logs?token=${encodeURIComponent(this.backends.keyFor(b))}&level=${encodeURIComponent(level)}`;
  }
}