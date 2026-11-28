#!/usr/bin/env node
/**
 * mock_clash.mjs — 本地假 clash_api + 静态托管管理台产物，用来在没有路由的环境里验收前端。
 *
 * 为什么要有：连接子页（三档视图 / 已关闭差分 / 排序 / 分组 / 详情）需要真实形态的数据才验收得出来，
 * 而真路由的 9090 通常只对内网放行、还带密钥。这个 mock 同时模拟 sing-box 1.15 的应答形状
 * （metadata 只有 destinationIP/destinationPort/dnsMode/host/network/processPath/sourceIP/sourcePort/type，
 * chains[0] 是实际出口、末位是分组，rule 是 `rule_set=… => route(…)` 表达式），
 * 以及「字节持续增长 / 连接自然消失 / 手动断开」三种动态。
 *
 * 用法：
 *   cd web/console && npx ng build --configuration development --base-href=/
 *   node ../../scripts/mock_clash.mjs            # 默认 8080，静态目录 web/console/dist/console/browser
 *   # 浏览器打开 http://127.0.0.1:8080/ ，后端地址填 http://127.0.0.1:8080 ，密钥随便填
 *   MOCK_PORT=8081 MOCK_CONNS=800 node scripts/mock_clash.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const DIST = process.env.MOCK_DIST ?? join(ROOT, 'web/console/dist/console/browser');
const PORT = Number(process.env.MOCK_PORT ?? 8080);
const WANT = Number(process.env.MOCK_CONNS ?? 420);

/* ── 造数据 ── */

const SRC_IPS = [
  '172.16.8.105',
  '172.16.8.179',
  '172.16.8.122',
  '192.168.31.20',
  '192.168.31.45',
  '192.168.31.8',
];
const HOSTS = [
  'www.google.com',
  'github.com',
  'api.openai.com',
  'chatgpt.com',
  'www.bilibili.com',
  'api.telegram.org',
  'mtalk.google.com',
  'registry-1.docker.io',
  'docs.rs',
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
  'www.youtube.com',
  'claude.ai',
  'api.anthropic.com',
  'www.zhihu.com',
  'update.googleapis.com',
  'ntp.aliyun.com',
  '',
  '',
];
const GROUPS = ['🐟 漏网之鱼', 'Bard', '🎯 全球直连', '📢 谷歌FCM', 'OpenAi', 'BALANCE', 'AI'];
const NODES = ['ali.vmess', 'iplc-ss', 'g.t', 'DIRECT', 'us-vless-1', 'hk-hy2', 'sg-tuic'];
const RULE_EXPRS = [
  ['rule_set=cn_ip => route(DIRECT)', ''],
  ['rule_set=rs-openai => route(OpenAi)', ''],
  ['rule_set=bard-domains => route(Bard)', ''],
  ['rule_set=rs-fcm => route(📢 谷歌FCM)', ''],
  ['rule_set=rs-gdirect => route(🎯 全球直连)', ''],
  ['rule_set=rs-ai => route(AI)', ''],
  ['final', ''],
  ['domain_suffix=google.com', 'route(🐟 漏网之鱼)'],
];
const DNS = ['normal', 'normal', 'normal', 'fakeip'];
const TYPES = ['tun/tun-in', 'tun/tun-in', 'tun/tun-in', 'mixed-in'];

let seq = 0;
/** 造一条连接；ageSec 越大表示越老（用来铺出 ≥5 分 / ≥30 分的档位） */
function makeConn(now, ageSec) {
  const src = pick(SRC_IPS);
  const host = pick(HOSTS);
  const dst = host
    ? `${(20 + Math.floor(Math.random() * 200)).toString()}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
    : `192.168.31.${10 + Math.floor(Math.random() * 60)}`;
  const group = pick(GROUPS);
  const node = pick(NODES);
  const chains = node === 'DIRECT' ? ['DIRECT', '🎯 全球直连'] : Math.random() < 0.45 ? [node, group] : Math.random() < 0.5 ? [node] : [node, 'BALANCE', group];
  const [rule, rulePayload] = pick(RULE_EXPRS);
  const udp = Math.random() < 0.3;
  const dl = Math.floor(Math.random() * 4_000_000);
  const ul = Math.floor(Math.random() * 400_000);
  return {
    id: `mock-${++seq}`,
    upload: ul,
    download: dl,
    start: new Date(now - ageSec * 1000).toISOString(),
    chains,
    rule,
    rulePayload,
    metadata: {
      destinationIP: dst,
      destinationPort: String(udp ? 443 : 80 + Math.floor(Math.random() * 8000)),
      dnsMode: pick(DNS),
      host,
      network: udp ? 'udp' : 'tcp',
      processPath: '',
      sourceIP: src,
      sourcePort: String(30000 + Math.floor(Math.random() * 30000)),
      type: pick(TYPES),
    },
    /** 还剩多少次快照后自然消失（0 = 长期存活） */
    ttl: Math.random() < 0.12 ? 1 + Math.floor(Math.random() * 8) : 0,
    /** 僵死样本：永不增长字节，用来演示「空转」与批量断开 */
    stuck: Math.random() < 0.08,
  };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const now0 = Date.now();
let conns = Array.from({ length: WANT }, (_, i) => {
  // 前 15% 造老连接（30 分 ~ 2 小时），其余按秒铺开
  const age = i < WANT * 0.15 ? 1800 + Math.random() * 5400 : Math.random() * 900;
  return makeConn(now0, age);
});
/** 每次取快照：长一点字节、老连接偶尔下线、补几条新的（保持总量大致稳定） */
function step() {
  const now = Date.now();
  const gone = [];
  const alive = [];
  for (const c of conns) {
    // 约 1/3 的连接这 2 秒里在跑数据，其余静止（空转）；stuck 的永不增长
    if (!c.stuck && Math.random() < 0.34) {
      c.download += Math.floor(Math.random() * 120_000);
      c.upload += Math.floor(Math.random() * 20_000);
    }
    if (c.ttl > 0) {
      c.ttl -= 1;
      if (c.ttl <= 0) {
        gone.push(c);
        continue;
      }
    }
    alive.push(c);
  }
  conns = alive;
  // 下线的那些补成新连接，让「活跃 / 已关闭」两边都有得看
  for (let i = 0; i < gone.length; i++) conns.push(makeConn(now, Math.random() * 5));
  // 被手动断开 / 全部断开后补足，保证页面不会永远空着
  while (conns.length < WANT) conns.push(makeConn(now, Math.random() * 60));
  if (process.env.MOCK_DEBUG) {
    console.log('[step] conns', conns.length, 'ttl>0', conns.filter((c) => c.ttl > 0).length, 'gone', gone.length);
  }
}

/* ── 应答 ── */

const VERSION = { version: '1.15.0-alpha.13-mock', meta: true };

const PROXIES = {
  proxies: {
    // 与 /router/config 同名的分组：流向图 ⑤ 行的「激活 / 测速」用（Selector 可切、URLTest 只读）
    '🚀 节点选择': {
      type: 'Selector',
      name: '🚀 节点选择',
      now: '🇭🇰 香港 01',
      all: ['🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 03', 'DIRECT'],
    },
    '📲 电报信息': { type: 'Selector', name: '📲 电报信息', now: '🚀 节点选择', all: ['🚀 节点选择', 'DIRECT'] },
    '♻️ 自动选择': { type: 'URLTest', name: '♻️ 自动选择', now: '🇭🇰 香港 01', all: ['🇭🇰 香港 01', '🇯🇵 日本 02'] },
    '🍎 苹果服务': { type: 'Selector', name: '🍎 苹果服务', now: 'DIRECT', all: ['DIRECT'] },
    '🇭🇰 香港 01': { type: 'Shadowsocks', name: '🇭🇰 香港 01', history: [{ time: new Date().toISOString(), delay: 38 }] },
    '🇯🇵 日本 02': { type: 'Shadowsocks', name: '🇯🇵 日本 02', history: [{ time: new Date().toISOString(), delay: 92 }] },
    '🇺🇸 美国 03': { type: 'Trojan', name: '🇺🇸 美国 03', history: [{ time: new Date().toISOString(), delay: 210 }] },
    Bard: { type: 'Selector', name: 'Bard', now: 'iplc-ss', all: ['iplc-ss', 'ali.vmess', 'hk-hy2'] },
    OpenAi: { type: 'Selector', name: 'OpenAi', now: 'ali.vmess', all: ['ali.vmess', 'us-vless-1'] },
    AI: { type: 'Selector', name: 'AI', now: 'sg-tuic', all: ['sg-tuic', 'ali.vmess'] },
    '🐟 漏网之鱼': { type: 'Selector', name: '🐟 漏网之鱼', now: '🚀 节点选择', all: ['🚀 节点选择', 'DIRECT'] },
    BALANCE: { type: 'URLTest', name: 'BALANCE', now: 'hk-hy2', all: ['hk-hy2', 'us-vless-1', 'iplc-ss'] },
    '🎯 全球直连': { type: 'Selector', name: '🎯 全球直连', now: 'DIRECT', all: ['DIRECT'] },
    '📢 谷歌FCM': { type: 'Selector', name: '📢 谷歌FCM', now: 'g.t', all: ['g.t', 'ali.vmess'] },
    'ali.vmess': { type: 'Shadowsocks', name: 'ali.vmess', history: [{ time: new Date().toISOString(), delay: 42 }] },
    'iplc-ss': { type: 'Shadowsocks', name: 'iplc-ss', history: [{ time: new Date().toISOString(), delay: 88 }] },
    'g.t': { type: 'Trojan', name: 'g.t', history: [{ time: new Date().toISOString(), delay: 120 }] },
    'us-vless-1': { type: 'VLESS', name: 'us-vless-1', history: [{ time: new Date().toISOString(), delay: 210 }] },
    'hk-hy2': { type: 'Hysteria2', name: 'hk-hy2', history: [{ time: new Date().toISOString(), delay: 65 }] },
    'sg-tuic': { type: 'TUIC', name: 'sg-tuic', history: [{ time: new Date().toISOString(), delay: 150 }] },
    DIRECT: { type: 'Direct', name: 'DIRECT' },
  },
};

const ROUTES = {
  rules: [
    { type: 'logical', payload: '', proxy: '🐟 漏网之鱼' },
    { type: 'remote', payload: 'cn_ip', proxy: '🎯 全球直连' },
    { type: 'remote', payload: 'rs-openai', proxy: 'OpenAi' },
    { type: 'default', payload: '', proxy: '🐟 漏网之鱼' },
  ],
};

const CONFIGS = { mode: 'rule', 'mode-list': ['rule', 'global', 'direct'], 'log-level': 'info' };

/* ── HTTP ── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, body, code = 200) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 读请求体（PUT /proxies/<组> 的 {name} 要用） */
/** 每台「路由」被 apply 之后生效的配置：host → { config, sha }（模拟真实服务的落盘） */
const appliedByHost = new Map();

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
    });
    req.on('end', () => resolve(buf));
    req.on('error', () => resolve(buf));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    return res.end();
  }

  // clash_api 模拟（同源，页面把后端地址填成 http://127.0.0.1:<port> 即可）
  if (path === '/version') return json(res, VERSION);
  if (path === '/proxies') return json(res, PROXIES);
  if (path === '/rules') return json(res, ROUTES);
  // 3/4 弹窗（规则集 / 分组）需要 /router/config：给一份带多分组、多节点、多 rule_set 的假配置
  // sing-box check 的 mock：MOCK_CHECK_FAIL=1 时模拟校验不过（用于批量应用的失败分支）
  // 规则桶清单（NAS 目录的 mock）：与 mock 配置里的 rule_set 部分同名，供「从后端规则集选」测试
  if (path === '/rule-set/index') {
    const names = ['rs-tg', 'rs-github', 'rs-msft', 'rs-apple', 'cn_ip', 'bard-domains', 'rs-netflix', 'rs-youtube', 'rs-openai', 'rs-telegram'];
    return json(res, {
      ok: true,
      dir: 'mock://rule-set',
      buckets: names.map((name) => ({ name, jsonSize: 1024, jsonTime: '2026-11-01T00:00:00Z', srsSize: 512, srsTime: '2026-11-01T00:00:00Z' })),
    });
  }
  if (path === '/router/check') {
    let host = 'mock';
    try { host = JSON.parse((await readBody(req)) || '{}').host || 'mock'; } catch { /* 忽略 */ }
    if (process.env.MOCK_CHECK_FAIL === '1') {
      return json(res, { ok: false, host, output: 'FATAL route.rules[0]: outbound not found: NOPE' });
    }
    return json(res, { ok: true, host, output: '' });
  }
  // 测试用：MOCK_CONFIG_FAIL=1 让 /router/config 返回 SSH 失败（验证连接页/凭据逻辑）
  if (path === '/router/config' && process.env.MOCK_CONFIG_FAIL === '1') {
    return json(res, { ok: false, error: 'ssh: handshake failed: ssh: unable to authenticate (Permission denied)' }, 500);
  }
  if (path === '/router/config') {
    {
      // 已经被 apply 过的配置优先返回：真实服务里 apply 是落盘的，
      // 之后读配置必须读到新内容，否则「应用后重新核对状态」永远对不上
      const h = new URL(req.url, 'http://x').searchParams.get('host') || '';
      const applied = appliedByHost.get(h);
      if (applied) return json(res, { config: applied.config, sha256: applied.sha, size: applied.config.length });
    }
    // 按 host 区分不同「路由」：真实服务是按 host 选凭据再 SSH 到不同路由的，
    // mock 只有一个进程，就用 host 查询参数返回不同的配置。
    // host=router-b 时「📲 电报信息」引用 rs-telegram-b，其余引用 rs-tg ——
    // 用来验证共享规则树在多台同时展开时「在甲的行点＋」不会拿到乙的 refs。
    // 兼容旧用法 MOCK_TG_REF（整进程统一改）。
    const host = new URL(req.url, 'http://x').searchParams.get('host') || '';
    const tgRef = host === 'router-b' ? 'rs-telegram-b' : (process.env.MOCK_TG_REF || 'rs-tg');
    const cfg = {
      log: { level: 'info' },
      inbounds: [{ type: 'tun', tag: 'tun-in' }],
      outbounds: [
        { type: 'selector', tag: '🚀 节点选择', outbounds: ['🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 03', 'DIRECT'] },
        { type: 'selector', tag: '📲 电报信息', outbounds: ['🚀 节点选择', 'DIRECT'] },
        { type: 'urltest', tag: '♻️ 自动选择', outbounds: ['🇭🇰 香港 01', '🇯🇵 日本 02'] },
        { type: 'selector', tag: '🍎 苹果服务', outbounds: ['DIRECT'] },
        { type: 'selector', tag: '🎯 全球直连', outbounds: ['DIRECT'] },
        { type: 'selector', tag: '🐟 漏网之鱼', outbounds: ['🚀 节点选择', 'DIRECT'] },
        { type: 'shadowsocks', tag: '🇭🇰 香港 01', server: '1.1.1.1', server_port: 443 },
        { type: 'shadowsocks', tag: '🇯🇵 日本 02', server: '1.1.1.2', server_port: 443 },
        { type: 'trojan', tag: '🇺🇸 美国 03', server: '1.1.1.3', server_port: 443 },
        { type: 'vmess', tag: '🇸🇬 新加坡 04', server: '1.1.1.4', server_port: 443 },
        { type: 'direct', tag: 'DIRECT' },
        { type: 'direct', tag: 'direct' },      // 小写变体：格式化时并入 DIRECT
        { type: 'selector', tag: 'OpenAi', outbounds: ['DIRECT'] }, // 混合大小写：格式化时变大写
        { type: 'block', tag: 'REJECT' },
      ],
      route: {
        rule_set: [
          { type: 'remote', tag: 'rs-tg', url: 'http://x/rs-tg.srs' },
          ...(tgRef !== 'rs-tg' ? [{ type: 'remote', tag: tgRef, url: `http://x/${tgRef}.srs` }] : []),
          { type: 'remote', tag: 'rs-github', url: 'http://x/rs-github.srs' },
          { type: 'remote', tag: 'rs-netflix', url: 'http://x/rs-netflix.srs' },
          { type: 'remote', tag: 'rs-apple', url: 'http://x/rs-apple.srs' },
          { type: 'remote', tag: 'rs-msft', url: 'http://x/rs-msft.srs' },
          { type: 'local', tag: 'cn_ip', path: 'cn.srs' },
          { type: 'local', tag: 'bard-domains', path: 'bard.srs' },
        ],
        rules: [
          // MOCK_TG_REF 可换掉「📲 电报信息」引用的规则集：起两个实例给不同值，
          // 用来验证共享规则树在多台同时展开时「在甲的行点＋」不会拿到乙的 refs
          { rule_set: [tgRef], outbound: '📲 电报信息' },
          { rule_set: ['rs-github', 'rs-msft'], outbound: '🚀 节点选择' },
          { rule_set: ['cn_ip'], outbound: 'DIRECT' },
          { ip_cidr: ['192.168.0.0/16'], outbound: 'direct' },
          { port: [6969], outbound: 'DIRECT' },
          { port: [2710], outbound: 'DIRECT' },
          { port: [1337], outbound: 'DIRECT' },
          { rule_set: ['rs-apple'], outbound: 'OpenAi' },
        ],
        final: '🐟 漏网之鱼',
      },
      experimental: { clash_api: { external_controller: '0.0.0.0:9090' } },
    };
    const text = JSON.stringify(cfg, null, 2);
    return json(res, { ok: true, host: '127.0.0.1', name: 'mock', config: text, size: text.length, sha256: 'mock', mtime: '' });
  }
  // 「保存并重启」链路：凭据清单 + apply（MOCK_APPLY=fail 可模拟失败，默认成功）
  if (path === '/router/credentials') {
    const need = process.env.MOCK_NOCRED === '1';
    return json(res, { ok: true, hosts: [{ host: '127.0.0.1', user: need ? '' : 'root', configured: !need }] });
  }
  if (path === '/router/apply') {
    const mode = process.env.MOCK_APPLY || 'ok';
    if (mode === 'fail') {
      return json(res, { ok: false, error: 'sing-box check 未通过：level: unknown field "levelz"' }, 400);
    }
    if (mode === 'slow') {
      // 让前端看得到完整进度推进
      const until = Date.now() + 9000;
      while (Date.now() < until) {
        /* 阻塞模拟长耗时 */
      }
    }
    // 记住每台路由「已生效」的配置（真实服务里 apply 是落盘的）
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const crypto = await import('node:crypto');
      appliedByHost.set(String(body.host || ''), {
        config: String(body.config || ''),
        sha: crypto.createHash('sha256').update(String(body.config || '')).digest('hex'),
      });
    } catch { /* 忽略坏请求体 */ }
    return json(res, { ok: true, changed: true, log: 'APPLIED' });
  }
  // ── 版本管理（最小实现，供「版本管理」页与部署失败路径的 UI 回归）──
  if (path === '/router/versions') {
    return json(res, {
      cacheDir: '/tmp/mock-singbox',
      disk: { freeMB: 875, totalMB: 4324 },
      local: [
        { version: '1.15.0-alpha.15', arch: 'amd64', variant: 'musl', size: 31251303,
          sha256: 'b'.repeat(64), at: '2026-11-28T10:34:13Z', source: 'https://gh-proxy.com/' },
      ],
      routers: [{ host: '127.0.0.1', name: 'mock', arch: 'amd64', libc: 'musl',
                  version: '1.15.0-alpha.15', bin: '/opt/sing-box/sing-box', binMB: 85,
                  freeMB: 115, backup: true, probedAt: '2026-11-28T10:34:13Z' }],
    });
  }
  if (path === '/router/versions/available') {
    return json(res, {
      releases: [
        { version: '1.15.0-alpha.15', note: '最新' },
        { version: '1.15.0-alpha.14', note: '' },
        { version: '1.15.0-alpha.9', note: '' },
      ],
    });
  }
  if (path === '/router/versions/deploy' && req.method === 'POST') {
    await readBody(req);
    // MOCK_DEPLOY_FAIL=1：只回 {error}（**前置校验失败**的形状，不含 uploadSecs/secs/log）。
    // 「版本管理」页原来把这个形状强转成 DeployResp 塞进模板，模板读 uploadSecs.toFixed 直接抛
    // TypeError 卡死 —— 这条分支就是那个回归点。
    if (process.env.MOCK_DEPLOY_FAIL === '1') {
      return json(res, { error: '192.168.31.32/amd64/musl 还没下载到 99，先在版本库里下载' }, 400);
    }
    return json(res, { ok: true, host: '127.0.0.1', version: '1.15.0-alpha.15', arch: 'amd64',
      before: '1.15.0-alpha.15', after: '1.15.0-alpha.15', sizeMB: 85, uploadSecs: 11.8,
      secs: 50.9, backup: true, freeMB: 115, log: 'DEPLOYED\ndowntime_s=2' });
  }
  if (path === '/configs') return json(res, CONFIGS);
  if (path === '/connections' && req.method === 'GET') {
    step();
    const downloadTotal = conns.reduce((n, c) => n + c.download, 0);
    const uploadTotal = conns.reduce((n, c) => n + c.upload, 0);
    return json(res, {
      connections: conns,
      downloadTotal,
      uploadTotal,
      memory: 0,
    });
  }
  if (path === '/connections' && req.method === 'DELETE') {
    conns = [];
    return json(res, null, 204);
  }
  if (path.startsWith('/connections/') && req.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/connections/'.length));
    conns = conns.filter((c) => c.id !== id);
    return json(res, null, 204);
  }
  // 注：断开后不用墓碑——被移除的对象不会再回来，step() 会补新连接
  // Selector 切换（流向图 ⑤ 弹层「激活」/ 分组与节点子页点 chip 共用）：有状态，回读 /proxies 能看到 now 变了
  if (path.startsWith('/proxies/') && req.method === 'PUT') {
    const tag = decodeURIComponent(path.slice('/proxies/'.length));
    const raw = await readBody(req);
    let name = '';
    try {
      name = String(JSON.parse(raw || '{}')?.name ?? '');
    } catch {
      name = '';
    }
    const g = PROXIES.proxies[tag];
    if (!g || g.type !== 'Selector') return json(res, { message: 'selector not found' }, 400);
    if (!(g.all ?? []).includes(name)) return json(res, { message: 'member not in group' }, 400);
    g.now = name;
    return json(res, null, 204);
  }
  // 单节点测速：有 history 的沿用末次值，其余按名字造一个稳定的毫秒数（便于断言文案）
  if (path.startsWith('/proxies/') && path.endsWith('/delay')) {
    const name = decodeURIComponent(path.slice('/proxies/'.length, -'/delay'.length));
    const h = PROXIES.proxies[name]?.history ?? [];
    const delay = h.length ? h[h.length - 1].delay : 60 + (name.length * 7) % 400;
    return json(res, { delay });
  }

  // 管理台同源接口（顶栏存储体检 / 规则桶）：给一个体面的假值，避免页面到处报错
  if (path === '/share/health') {
    return json(res, {
      file: { mode: 'smb', ok: true, files: 47, detail: 'mock 目录可读', ms: 3 },
      http: { url: 'https://rules.example.com/', ok: true, status: 200, size: 1024, ms: 12 },
    });
  }
  if (path === '/share/config') return json(res, { mode: 'smb', smb: {}, sftp: {}, http: {} });

  // 静态产物（SPA 回退）
  const file = path === '/' ? '/index.html' : path;
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  } catch {
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`没有找到静态产物：${DIST}\n先执行 cd web/console && npx ng build --configuration development --base-href=/\n`);
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock clash_api + 管理台：http://127.0.0.1:${PORT}/  （${WANT} 条连接，静态目录 ${DIST}）`);
});