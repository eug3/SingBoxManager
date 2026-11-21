import { Injectable, signal } from '@angular/core';

/** 一台路由的「配置通道」连接状态（配置页读取成功/失败后回报） */
export interface RouterStatus {
  host: string;
  ok: boolean;
  /** 成功时：配置字节数与 sha 前 12 位、节点条目数 */
  size?: number;
  sha?: string;
  nodes?: number;
  /** 失败时的错误文案 */
  error?: string;
  /** 最近一次更新的时间戳（毫秒） */
  ts: number;
}

/**
 * 跨组件状态总线（很小，只放两件事）：
 *  1. 各路由的配置通道状态 —— 顶栏右侧那个状态点用；
 *  2. 「请切到某个后端的配置页」请求 —— 顶栏点状态点时触发。
 * 配置页写、顶栏读；后端面板负责消费切页请求。
 */
@Injectable({ providedIn: 'root' })
export class RouterStatusService {
  readonly statuses = signal<Record<string, RouterStatus>>({});
  /** 切页请求：值为后端下标，消费后置回 null */
  readonly configTabRequest = signal<number | null>(null);

  /** 配置页在读取成功/失败后回报 */
  report(s: RouterStatus): void {
    this.statuses.update((m) => ({ ...m, [s.host]: s }));
  }

  /** 顶栏点击状态点：请求打开该后端的「配置」子页 */
  requestConfigTab(index: number): void {
    this.configTabRequest.set(index);
  }

  /** 后端面板读取并清零（避免重复触发） */
  takeConfigTabRequest(): number | null {
    const v = this.configTabRequest();
    if (v !== null) this.configTabRequest.set(null);
    return v;
  }
}