/**
 * node-form.ts — 「配置」页节点表单的模型与转换（纯函数，不碰组件状态）。
 *
 * NodeForm 是表单的扁平结构；buildNode 把它校验并转成 sing-box outbound 对象，
 * formFromNode 反向把现有 outbound 摊平进表单。协议字段差异都在这里收口。
 */

import { AnyObj } from './config-ops';

/** 表单支持的节点协议（endpoints 类如 masque-client 请走「编辑 JSON」） */
export const NODE_TYPES = ['shadowsocks', 'vmess', 'vless', 'trojan', 'socks', 'hysteria2', 'tuic', 'anytls'];

/** 节点表单的扁平字段（tls/transport 拆成布尔与字符串，方便绑定输入框） */
export interface NodeForm {
  tag: string;
  type: string;
  server: string;
  server_port: number;
  method: string;
  password: string;
  uuid: string;
  alter_id: number;
  security: string;
  flow: string;
  tls: boolean;
  tls_server_name: string;
  tls_insecure: boolean;
  transport: 'none' | 'ws' | 'grpc';
  transport_path: string;
  transport_service: string;
  socks_version: string;
}

/** 新增节点的默认表单 */
export function emptyForm(): NodeForm {
  return {
    tag: '',
    type: 'shadowsocks',
    server: '',
    server_port: 443,
    method: 'aes-256-gcm',
    password: '',
    uuid: '',
    alter_id: 0,
    security: 'auto',
    flow: '',
    tls: false,
    tls_server_name: '',
    tls_insecure: false,
    transport: 'none',
    transport_path: '/',
    transport_service: '',
    socks_version: '5',
  };
}

/** 把现有 outbound 摊平进表单（编辑模式回填） */
export function formFromNode(tag: string, o: AnyObj): NodeForm {
  const tls = (o['tls'] ?? {}) as AnyObj;
  const tr = (o['transport'] ?? {}) as AnyObj;
  return {
    tag,
    type: String(o['type'] ?? 'shadowsocks'),
    server: String(o['server'] ?? ''),
    server_port: Number(o['server_port'] ?? 0),
    method: String(o['method'] ?? ''),
    password: String(o['password'] ?? ''),
    uuid: String(o['uuid'] ?? ''),
    alter_id: Number(o['alter_id'] ?? 0),
    security: String(o['security'] ?? 'auto'),
    flow: String(o['flow'] ?? ''),
    tls: tls['enabled'] === true,
    tls_server_name: String(tls['server_name'] ?? ''),
    tls_insecure: tls['insecure'] === true,
    transport: (tr['type'] as 'ws' | 'grpc') ?? 'none',
    transport_path: String(tr['path'] ?? '/'),
    transport_service: String(tr['service_name'] ?? ''),
    socks_version: String(o['version'] ?? '5'),
  };
}

export type BuildResult = { ok: true; node: AnyObj } | { ok: false; error: string };

/** buildNode 校验必填项并按协议组装 outbound；失败返回错误文案（组件直接展示） */
export function buildNode(f: NodeForm): BuildResult {
  if (!f.tag.trim() || !f.server.trim() || !f.server_port) {
    return { ok: false, error: '标签 / 服务器 / 端口 必填' };
  }
  const node: AnyObj = { type: f.type, tag: f.tag.trim(), server: f.server.trim(), server_port: f.server_port };

  // —— 协议专属字段 ——
  switch (f.type) {
    case 'shadowsocks':
      if (!f.method.trim() || !f.password) return { ok: false, error: 'shadowsocks 需要 method 与 password' };
      node['method'] = f.method.trim();
      node['password'] = f.password;
      break;
    case 'vmess':
      if (!f.uuid.trim()) return { ok: false, error: 'vmess 需要 uuid' };
      node['uuid'] = f.uuid.trim();
      node['security'] = f.security || 'auto';
      node['alter_id'] = f.alter_id;
      break;
    case 'vless':
      if (!f.uuid.trim()) return { ok: false, error: 'vless 需要 uuid' };
      node['uuid'] = f.uuid.trim();
      if (f.flow.trim()) node['flow'] = f.flow.trim();
      break;
    case 'trojan':
    case 'hysteria2':
    case 'tuic':
    case 'anytls':
      if (!f.password) return { ok: false, error: `${f.type} 需要密码` };
      node['password'] = f.password;
      break;
    case 'socks':
      node['version'] = f.socks_version || '5';
      if (f.password) {
        node['username'] = f.uuid || ''; // socks 的用户名借用 uuid 输入框（模板里标签是「用户名」）
        node['password'] = f.password;
      }
      break;
  }

  // —— TLS（ss/socks 不适用）——
  if (f.tls && f.type !== 'shadowsocks' && f.type !== 'socks') {
    const tls: AnyObj = { enabled: true, server_name: f.tls_server_name || f.server };
    if (f.tls_insecure) tls['insecure'] = true;
    node['tls'] = tls;
  }

  // —— 传输层（tcp 不写 transport 字段）——
  if (f.transport !== 'none') {
    node['transport'] =
      f.transport === 'ws'
        ? { type: 'ws', path: f.transport_path || '/' }
        : { type: 'grpc', service_name: f.transport_service || '' };
  }
  return { ok: true, node };
}