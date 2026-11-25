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
  if (n < 1024) return Math.round(n) + 'B/s';
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
  const x = e as { error?: { error?: string }; status?: number; message?: string };
  return x?.error?.error ?? x?.message ?? String(e);
}

/** 时长（秒）→ 文案：<60s 显示秒、<1h 显示分、其余 时+分（连接存活 / 空转共用） */
export function ageText(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + '分';
  return Math.floor(sec / 3600) + '时' + Math.floor((sec % 3600) / 60) + '分';
}

/** 时长着色：≥30 分钟红（很可能僵死）、≥5 分钟黄（偏老）、其余正常 */
export function ageClass(sec: number): string {
  if (sec >= 1800) return 'r';
  if (sec >= 300) return 'y';
  return '';
}

/** 时间戳 / ISO 串 → 本地 HH:MM:SS（解析失败返回空串） */
export function clockText(v: string | number | undefined | null): string {
  if (!v) return '';
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * runPool — 固定并发的工作池：items 逐个交给 worker，最多 concurrency 个并行。
 * 用于「全部测速」这类要对几十个节点逐个发请求的场景（并发 6 与旧实现一致）。
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
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

/**
 * 浏览器层面的网络失败（不是服务端业务错误）：
 * Angular 的 HttpErrorResponse 在「请求没走完」时 status=0、statusText=undefined，
 * 文案形如 `Http failure response for /router/config?host=…: 0 undefined`；
 * 另有 Chrome 的 net::ERR_* 与超时。这类错误不代表写没写成功，文案不能按业务错误处理。
 */
export function isNetworkErr(err: unknown): boolean {
  const msg = typeof err === 'string' ? err : String((err as { message?: string })?.message ?? err ?? '');
  return /Http failure response/i.test(msg) || /\bstatus 0\b|: 0 undefined|net::ERR_|ERR_CONNECTION|ERR_NETWORK|ERR_EMPTY_RESPONSE|timeout|Timed out/i.test(msg);
}
