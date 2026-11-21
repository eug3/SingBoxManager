/**
 * vault.service.ts — 规则桶读写客户端（同源 99 Go 服务）。
 * 拉 /rule-set/<桶>.json、HEAD .srs 看大小/时间、POST /publish 发布（带 X-Vault-Key）。
 * validate 为前端即时预校验（服务端仍会再校验），ALLOWED 为桶规则合法键白名单。
 */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BUCKETS, PublishResp } from './models';
import { fmtBytes } from './util';

/** 预校验结果：ok + 概要 msg + 明细 detail */
export interface RuleCheck {
  ok: boolean;
  msg: string;
  detail: string;
}

/** 桶规则允许的匹配键（与服务端 ruleKeys 口径一致；非法键服务端拒收） */
const ALLOWED = new Set([
  'domain',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
  'ip_cidr',
  'ip_is_private',
  'source_ip_cidr',
  'port',
  'port_range',
  'network',
  'protocol',
]);

/** 规则桶读写：拉 /rule-set/<桶>.json、发布 /publish（同源，99 上的 Go 服务） */
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly http = inject(HttpClient);

  bucketLabels = BUCKETS.map(([name, rules]) => ({ name, rules }));

  /** 拉某桶的 .json 源文本（no-cache） */
  async fetch(bucket: string): Promise<string> {
    const text = await firstValueFrom(
      this.http.get(`/rule-set/${bucket}.json`, {
        responseType: 'text',
        headers: new HttpHeaders({ 'Cache-Control': 'no-cache' }),
      }),
    );
    return text;
  }

  /** HEAD 拿线上 .srs 的大小与 Last-Modified（失败返回 null） */
  async head(bucket: string): Promise<{ size: string; time: string } | null> {
    try {
      const resp = await firstValueFrom(
        this.http.head(`/rule-set/${bucket}.srs`, { observe: 'response', responseType: 'text' }),
      );
      return {
        size: resp.headers.get('Content-Length') ?? '?',
        time: resp.headers.get('Last-Modified') ?? '?',
      };
    } catch {
      return null;
    }
  }

  /** 发布桶内容：服务端校验→编译 .srs→成对写回存储 */
  async publish(bucket: string, content: string, key: string): Promise<PublishResp> {
    const headers = new HttpHeaders({ 'Content-Type': 'application/json', 'X-Vault-Key': key });
    return firstValueFrom(this.http.post<PublishResp>('/publish', { bucket, content }, { headers }));
  }

  /** 前端预校验（服务端仍会再校验一遍，这里是即时反馈） */
  validate(text: string): RuleCheck {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, msg: 'JSON 语法错误', detail: (e as Error).message };
    }
    const obj = data as { version?: unknown; rules?: unknown };
    if (obj?.version !== 1) return { ok: false, msg: 'version 必须是 1', detail: '当前值：' + JSON.stringify(obj?.version) };
    if (!Array.isArray(obj?.rules)) return { ok: false, msg: 'rules 必须是数组', detail: '' };

    const stats = new Map<string, number>();
    for (let i = 0; i < obj.rules.length; i++) {
      const r = obj.rules[i] as Record<string, unknown>;
      if (typeof r !== 'object' || r === null || Array.isArray(r)) {
        return { ok: false, msg: `第 ${i + 1} 条规则不是对象`, detail: '' };
      }
      const keys = Object.keys(r);
      const bad = keys.filter((k) => !ALLOWED.has(k));
      if (bad.length) {
        return { ok: false, msg: `第 ${i + 1} 条有非法键：${bad.join(', ')}`, detail: '非法桶规则的服务端会直接拒收' };
      }
      if (!keys.length) return { ok: false, msg: `第 ${i + 1} 条是空对象`, detail: '' };
      for (const k of keys) {
        const v = r[k];
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.length || arr.some((x) => typeof x !== 'string' || !x.trim())) {
          return { ok: false, msg: `第 ${i + 1} 条的 ${k} 必须是非空字符串数组`, detail: '' };
        }
        stats.set(k, (stats.get(k) ?? 0) + arr.length);
      }
    }
    const detail = [...stats.entries()].map(([k, n]) => `${k}×${n}`).join(' · ');
    return { ok: true, msg: `合法 · ${obj.rules.length} 条规则 / ${[...stats.values()].reduce((a, b) => a + b, 0)} 条目`, detail };
  }

  /** 格式化（2 空格缩进），不合法时抛错 */
  format(text: string): string {
    return JSON.stringify(JSON.parse(text), null, 2);
  }

  /** 字节格式化（转发 util.fmtBytes，保持模板口径统一） */
  formatBytes(n: number): string {
    return fmtBytes(n);
  }
}