/** share-link — 订阅/分享链接解析（ss / vmess / vless / trojan / hysteria2 / socks）→ sing-box outbound */

import { AnyObj } from './config-ops';

function b64decode(s: string): string {
  const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  try {
    return decodeURIComponent(
      bin
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
  } catch {
    return bin;
  }
}

function num(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function truthy(v: string | null): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

interface VmessJson {
  ps?: string;
  add?: string;
  port?: string;
  id?: string;
  aid?: string;
  scy?: string;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
  alpn?: string;
}

export interface ParsedNode {
  ok: boolean;
  node?: AnyObj;
  error?: string;
  link: string;
  warnings: string[];
}

function transportOf(net: string | null, path: string | null, host: string | null, serviceName: string | null): AnyObj | undefined {
  const t = (net ?? '').toLowerCase();
  if (t === 'ws') {
    const tr: AnyObj = { type: 'ws' };
    if (path) tr['path'] = path;
    if (host) tr['headers'] = { Host: host };
    return tr;
  }
  if (t === 'grpc') return { type: 'grpc', service_name: serviceName ?? '' };
  if (t === 'http') return { type: 'http', path: path ?? undefined, host: host ? [host] : undefined };
  return undefined;
}

function tlsOf(security: string | null, sni: string | null, insecure: string | null, alpn: string | null, server: string): AnyObj | undefined {
  const sec = (security ?? '').toLowerCase();
  if (sec !== 'tls' && sec !== 'reality') return undefined;
  const tls: AnyObj = { enabled: true, server_name: sni || server };
  if (truthy(insecure)) tls['insecure'] = true;
  if (alpn) tls['alpn'] = alpn.split(',');
  return tls;
}

export function parseShareLink(raw: string): ParsedNode {
  const link = raw.trim();
  const out: ParsedNode = { ok: false, link, warnings: [] };
  if (!link) {
    out.error = '空链接';
    return out;
  }
  try {
    const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
    const rest = link.slice(link.indexOf('://') + 3);
    const hashAt = rest.indexOf('#');
    const body = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
    const tag = hashAt >= 0 ? decodeURIComponent(rest.slice(hashAt + 1)) : '';

    if (scheme === 'ss') {
      // ss://base64(method:password)@host:port  |  ss://base64(method:password@host:port)
      let method = '';
      let password = '';
      let hostPort = '';
      if (body.includes('@')) {
        const [cred, hp] = body.split('@');
        const decoded = b64decode(cred);
        [method, password] = decoded.split(':');
        hostPort = hp.split('?')[0];
      } else {
        const decoded = b64decode(body.split('?')[0]);
        const at = decoded.lastIndexOf('@');
        const cred = decoded.slice(0, at);
        hostPort = decoded.slice(at + 1);
        [method, password] = cred.split(':');
      }
      const [server, port] = hostPort.split(':');
      out.node = {
        type: 'shadowsocks',
        tag: tag || `${server}-ss`,
        server,
        server_port: num(port),
        method,
        password,
      };
      out.ok = !!server && !!num(port) && !!method;
      if (!out.ok) out.error = 'ss 链接缺少服务器/端口/加密方式';
      return out;
    }

    if (scheme === 'vmess') {
      const j = JSON.parse(b64decode(body)) as VmessJson;
      const node: AnyObj = {
        type: 'vmess',
        tag: tag || j.ps || `${j.add}-vmess`,
        server: j.add,
        server_port: num(j.port),
        uuid: j.id,
        security: j.scy || 'auto',
        alter_id: num(j.aid ?? '0'),
      };
      const tr = transportOf(j.net ?? null, j.path ?? null, j.host ?? null, j.path ?? null);
      if (tr) node['transport'] = tr;
      const tls = tlsOf(j.tls ?? null, j.sni ?? j.host ?? null, null, j.alpn ?? null, j.add ?? '');
      if (tls) node['tls'] = tls;
      out.node = node;
      out.ok = !!j.add && !!num(j.port) && !!j.id;
      if (!out.ok) out.error = 'vmess 链接缺少 add/port/id';
      return out;
    }

    if (scheme === 'vless' || scheme === 'trojan' || scheme === 'hysteria2' || scheme === 'hy2' || scheme === 'socks' || scheme === 'socks5') {
      const qIdx = body.indexOf('?');
      const head = qIdx >= 0 ? body.slice(0, qIdx) : body;
      const query = new URLSearchParams(qIdx >= 0 ? body.slice(qIdx + 1) : '');
      const atIdx = head.lastIndexOf('@');
      const cred = atIdx >= 0 ? decodeURIComponent(head.slice(0, atIdx)) : '';
      const hp = atIdx >= 0 ? head.slice(atIdx + 1) : head;
      const [server, port] = hp.split(':');
      const net = query.get('type');
      const sni = query.get('sni') ?? query.get('peer') ?? query.get('host');
      const insecure = query.get('insecure') ?? query.get('allowInsecure');
      const tr = transportOf(net, query.get('path'), query.get('host'), query.get('serviceName') ?? query.get('service_name'));

      if (scheme === 'vless') {
        const node: AnyObj = {
          type: 'vless',
          tag: tag || `${server}-vless`,
          server,
          server_port: num(port),
          uuid: cred,
          flow: query.get('flow') ?? undefined,
        };
        const tls = tlsOf(query.get('security'), sni, insecure, query.get('alpn'), server ?? '');
        if (tls) node['tls'] = tls;
        if (tr) node['transport'] = tr;
        out.node = node;
        out.ok = !!server && !!num(port) && !!cred;
        if (!out.ok) out.error = 'vless 链接缺少 uuid/服务器/端口';
        return out;
      }

      if (scheme === 'trojan') {
        const node: AnyObj = {
          type: 'trojan',
          tag: tag || `${server}-trojan`,
          server,
          server_port: num(port),
          password: cred,
          tls: tlsOf('tls', sni, insecure, query.get('alpn'), server ?? '') ?? { enabled: true, server_name: server },
        };
        if (tr) node['transport'] = tr;
        out.node = node;
        out.ok = !!server && !!num(port) && !!cred;
        if (!out.ok) out.error = 'trojan 链接缺少密码/服务器/端口';
        return out;
      }

      if (scheme === 'hysteria2' || scheme === 'hy2') {
        const node: AnyObj = {
          type: 'hysteria2',
          tag: tag || `${server}-hy2`,
          server,
          server_port: num(port),
          password: cred,
          tls: tlsOf('tls', sni, insecure, query.get('alpn'), server ?? '') ?? { enabled: true, server_name: server },
        };
        if (query.get('obfs')) {
          node['obfs'] = { type: query.get('obfs'), password: query.get('obfs-password') ?? '' };
        }
        out.node = node;
        out.ok = !!server && !!num(port) && !!cred;
        if (!out.ok) out.error = 'hysteria2 链接缺少密码/服务器/端口';
        return out;
      }

      // socks / socks5
      let username = '';
      let password = '';
      if (cred) {
        const decoded = cred.includes(':') ? cred : b64decode(cred);
        [username, password] = decoded.split(':');
      }
      const node: AnyObj = {
        type: 'socks',
        tag: tag || `${server}-socks`,
        server,
        server_port: num(port),
        version: '5',
      };
      if (username) {
        node['username'] = username;
        node['password'] = password;
      }
      out.node = node;
      out.ok = !!server && !!num(port);
      if (!out.ok) out.error = 'socks 链接缺少服务器/端口';
      return out;
    }

    out.error = `不支持的协议：${scheme}`;
    return out;
  } catch (e) {
    out.error = (e as Error)?.message ?? String(e);
    return out;
  }
}

export function parseShareLinks(text: string): ParsedNode[] {
  return text
    .split(/[\r\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseShareLink);
}