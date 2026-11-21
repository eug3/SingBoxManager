/**
 * util.ts — 前端公共纯函数：字节/速率格式化、延迟分级、错误文案、并发池。
 * 之前这些逻辑在 overview / backend-pane / vault.service 里各写了一份，统一收敛到这里。
 */

import { LAT_LOW, LAT_MID } from './models';

/** 字节数 → 人类可读（B/K/M/G，1024 进制；页面各处统一用这个口径） */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'G';
}

/** 字节/秒 → B/s、K/s、M/s（概览速率行的次要读数） */
export function fmtRate(n: number): string {
  if (!n) return '0B/s';
  if (n < 1024) return n + 'B/s';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K/s';
  return (n / 1024 / 1024).toFixed(2) + 'M/s';
}

/** 字节/秒 → Mib/s（1 Mib = 2^20 bit，概览速率行的主读数） */
export function fmtMib(n: number): string {
  const mib = (n * 8) / (1024 * 1024);
  if (!mib) return '0 Mib/s';
  if (mib < 10) return mib.toFixed(2) + ' Mib/s';
  return mib.toFixed(1) + ' Mib/s';
}

/** Mib/s → 字节/秒（带宽输入框换算满量程用） */
export function mibToBytes(mib: number): number {
  return (mib * 1024 * 1024) / 8;
}

/** 延迟 → 颜色档位（zashboard 口径：<400ms 绿、<800ms 黄、其余/超时红、未测灰） */
export function latClass(d: number | null): string {
  if (d === null) return 'na';
  if (d <= 0) return 'r';
  if (d < LAT_LOW) return 'g';
  if (d < LAT_MID) return 'y';
  return 'r';
}

/** 延迟 → 文本（null 显示占位符；≥1s 用秒） */
export function latText(d: number | null, empty = ''): string {
  if (d === null) return empty;
  if (d <= 0) return '✗';
  return d >= 1000 ? (d / 1000).toFixed(1) + 's' : d + 'ms';
}

/** 从 HttpClient 错误 / Error / 任意值里提取可读文案（服务端约定 {"error": "..."}） */
export function errMsg(e: unknown): string {
  const x = e as { error?: { error?: string }; message?: string };
  return x?.error?.error ?? x?.message ?? String(e);
}

/**
 * runPool — 固定并发的工作池：items 逐个交给 worker，最多 concurrency 个并行。
 * 用于「全部测速」这类要对几十个节点逐个发请求的场景（并发 6 与旧实现一致）。
 */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const lane = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}