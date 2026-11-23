/** 一个 clash_api 后端（路由）；key 为该路由的 secret，空则用全局密钥 */
export interface Backend {
  name: string;
  api: string;
  key: string;
  /** 未保存的草稿：只在内存里，刷新即消失 */
  draft?: boolean;
}

/** GET /version 应答 */
export interface ClashVersion {
  version: string;
}

/** /proxies 里的一个条目：组（Selector/URLTest）或节点；history 是延迟测速记录 */
export interface ProxyNode {
  type: string;
  name: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
}

/** /proxies 应答：tag → 节点/组 */
export interface ProxiesResp {
  proxies: Record<string, ProxyNode>;
}

/** 连接的 metadata（sing-box clash_api 原始字段；sniffHost/process 为 mihomo 兼容字段） */
export interface ConnMeta {
  host?: string;
  sniffHost?: string;
  destinationIP?: string;
  destinationPort?: string;
  sourceIP?: string;
  sourcePort?: string;
  /** tcp / udp */
  network?: string;
  /** 入站类型，如 tun/tun-in、mixed-in */
  type?: string;
  /** DNS 解析模式（normal / fakeip …） */
  dnsMode?: string;
  /** 发起连接的进程路径（TUN 模式下通常为空） */
  processPath?: string;
  process?: string;
  /** 入站用户名（有 inbound user 时） */
  user?: string;
}

/** /connections 里的一条活跃连接（metadata 为来源/目标信息） */
export interface Connection {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: ConnMeta;
}

/** /connections 应答：累计总量 + 活跃连接数组 */
export interface ConnectionsResp {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: Connection[];
}

/** /rules 里的一条 route 规则（只读展示用） */
export interface RuleEntry {
  type?: string;
  payload?: string;
  proxy?: string;
}

/** /rules 应答 */
export interface RulesResp {
  rules?: RuleEntry[];
}

/** POST /publish 应答（error 非空即失败） */
export interface PublishResp {
  ok: boolean;
  bucket: string;
  json: number;
  srs: number;
  sha256: string;
  hint?: string;
  error?: string;
}

/** 管理台版本号（页脚展示；语义化版本，发版时手工更新） */
export const CONSOLE_VERSION = '0.1.0';

/**
 * 桶清单（与存储 rule-set 目录一致；第二个数字是历史快照规则条数，仅作展示参考）。
 * 已合并删除的桶（rs-custom-2 / rs-direct-2）不再列出。
 */
export const BUCKETS: [string, number][] = [
  ['rs-node', 13],
  ['rs-direct', 17],
  ['rs-fcm', 5],
  ['rs-custom', 12],
  ['rs-openai', 9],
  ['rs-balance', 1],
  ['rs-openai-2', 1],
  ['rs-iplc', 1],
  ['rs-custom-3', 1],
  ['rs-fish', 1],
  ['rs-node-2', 2],
  ['rs-gdirect', 9],
  ['rs-block', 2],
  ['rs-purify', 8],
  ['rs-direct-3', 1],
  ['rs-msft', 2],
  ['rs-apple', 3],
  ['rs-tg', 2],
  ['rs-media', 58],
  ['rs-node-3', 14],
  ['rs-gdirect-2', 7],
  ['bard-domains', 1],
];

/** 页面允许的来源（与两台路由 clash_api 的 CORS 白名单对应） */
export const PAGE_ORIGINS = ['http://192.168.31.99:9099', 'http://10.1.1.99:9099'];

/** zashboard 默认阈值：<400ms 绿、<800ms 黄、其余红 */
export const LAT_LOW = 400;
/** 黄→红 阈值（ms） */
export const LAT_MID = 800;
