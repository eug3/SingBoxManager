export interface Backend {
  name: string;
  api: string;
  key: string;
  /** 未保存的草稿：只在内存里，刷新即消失 */
  draft?: boolean;
}

export interface ClashVersion {
  version: string;
}

export interface ProxyNode {
  type: string;
  name: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
}

export interface ProxiesResp {
  proxies: Record<string, ProxyNode>;
}

export interface Connection {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: {
    host?: string;
    sniffHost?: string;
    destinationIP?: string;
    destinationPort?: string;
    network?: string;
  };
}

export interface ConnectionsResp {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: Connection[];
}

export interface RuleEntry {
  type?: string;
  payload?: string;
  proxy?: string;
}

export interface RulesResp {
  rules?: RuleEntry[];
}

export interface PublishResp {
  ok: boolean;
  bucket: string;
  json: number;
  srs: number;
  sha256: string;
  hint?: string;
  error?: string;
}

/** 桶清单（与 NAS rule-set 目录一致） */
export const CONSOLE_VERSION = '2026.11.21';

export const BUCKETS: [string, number][] = [
  ['rs-node', 13], ['rs-direct', 17], ['rs-fcm', 5], ['rs-custom', 12], ['rs-openai', 9],
  ['rs-custom-2', 1], ['rs-balance', 1], ['rs-openai-2', 1], ['rs-iplc', 1], ['rs-custom-3', 1],
  ['rs-fish', 1], ['rs-node-2', 2], ['rs-direct-2', 1], ['rs-gdirect', 9], ['rs-block', 2],
  ['rs-purify', 8], ['rs-direct-3', 1], ['rs-msft', 2], ['rs-apple', 3], ['rs-tg', 2],
  ['rs-media', 58], ['rs-node-3', 14], ['rs-gdirect-2', 7], ['bard-domains', 1],
];

/** 页面允许的来源（与两台路由 clash_api 的 CORS 白名单对应） */
export const PAGE_ORIGINS = ['http://192.168.31.99:9099', 'http://10.1.1.99:9099'];

/** zashboard 默认阈值：<400ms 绿、<800ms 黄、其余红 */
export const LAT_LOW = 400;
export const LAT_MID = 800;