import { Injectable, inject, signal } from '@angular/core';
import { ClashService } from './clash.service';
import { Backend, Connection } from './models';
import { errMsg } from './util';

/** 一次连接快照：原始列表 + 头部统计条要的两个数 */
export interface LiveSnapshot {
  /** 这份快照属于哪个后端（api 地址）：消费者按它过滤，切后端不会串数据 */
  api: string;
  /** 采样时刻（毫秒）：消费者按它去重，信号重放不会重复处理同一份数据 */
  at: number;
  /** 原始连接列表（连接页差分、流向图都直接消费） */
  conns: Connection[];
  /** 活跃条数 */
  count: number;
  /** 累计下行 / 上行字节（各连接计数之和） */
  down: number;
  up: number;
}

/** 默认采样间隔：只有头部统计条需要时 2s 足够 */
const DEFAULT_MS = 2000;

/**
 * LiveStatService — 全站唯一的 /connections 轮询者。
 *
 * 背景：头部统计条（活跃/流量）以前只由「连接」子页回传，停在其它子页就不刷新；
 * 若每个子页各自轮询，又会重复请求同一份数据。这里收敛成一个服务：
 *   · subscribe(backend, ms?) 登记消费者，同后端共享一条轮询链；
 *     间隔取所有消费者的最小值（连接页 2s、流向图 1.5s、头部兜底 2s）；
 *   · 每次拉到的快照写进 snap 信号（含 at 时间戳），各消费者按 at 去重后自行处理；
 *   · 最后一个订阅者退订时停止轮询并清空快照；页面隐藏时跳过拉取，回到前台立刻补一次。
 *
 * 数据消费者：backend-pane（头部统计条）、connections（列表/差分）、flow-anim（流向图）。
 */
@Injectable({ providedIn: 'root' })
export class LiveStatService {
  private readonly clash = inject(ClashService);

  /** 最近一次成功快照（null = 没有订阅者，或还没拉到过） */
  readonly snap = signal<LiveSnapshot | null>(null);
  /** 最近一次失败文案（401 单独措辞）；下一次成功自动清空 */
  readonly err = signal('');

  /** 订阅表：id → 该消费者用的后端与期望间隔 */
  private readonly subs = new Map<number, { backend: Backend; interval: number }>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  /** 回到前台立刻补一次（隐藏期间不拉） */
  private readonly onVisible = (): void => {
    if (!document.hidden) void this.tick();
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /**
   * 订阅连接快照。返回退订函数（组件销毁时调用）。
   * 同后端多个订阅共享一条轮询链，实际间隔 = 所有订阅里的最小值。
   */
  subscribe(backend: Backend, intervalMs = DEFAULT_MS): () => void {
    const id = ++this.seq;
    this.subs.set(id, { backend, interval: intervalMs });
    this.schedule();
    void this.tick(); // 立刻给一发，别让消费者等首个间隔
    return () => {
      this.subs.delete(id);
      this.schedule();
      if (!this.subs.size) this.snap.set(null); // 没人看了就清掉，免得留下上一后端的数
    };
  }

  /** 手动立即拉一次（连接页「刷新」按钮用） */
  async refresh(): Promise<void> {
    await this.tick(true);
  }

  /** 重排下一次采样（间隔取最小；没有订阅就停） */
  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.subs.size) return;
    const ms = Math.min(...[...this.subs.values()].map((s) => s.interval));
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** 拉一次；busy 时跳过本轮（仍重排下一次，不会断链） */
  private async tick(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sub = [...this.subs.values()].at(-1);
    const b = sub?.backend;
    if (b?.api && !this.busy && (force || document.visibilityState === 'visible')) {
      this.busy = true;
      try {
        const resp = await this.clash.connections(b);
        const conns = resp?.connections ?? [];
        let down = 0;
        let up = 0;
        for (const c of conns) {
          down += c.download ?? 0;
          up += c.upload ?? 0;
        }
        this.snap.set({ api: b.api, at: Date.now(), conns, count: conns.length, down, up });
        this.err.set('');
      } catch (e) {
        const x = e as { status?: number };
        this.err.set(x?.status === 401 ? '密钥未填或错误（401）' : errMsg(e));
      } finally {
        this.busy = false;
      }
    }
    this.schedule();
  }
}