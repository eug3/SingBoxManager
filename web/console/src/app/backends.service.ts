import { Injectable, computed, signal } from '@angular/core';
import { Backend } from './models';

const STORE_KEY = 'vaultKey';
const STORE_BACKENDS = 'clashBackends';

const DEFAULT_BACKENDS: Backend[] = [
  { name: '甲 · 主干', api: 'http://192.168.31.32:9090', key: '' },
  { name: '乙 · 侧翼', api: 'http://172.16.8.1:9090', key: '' },
];

/** 后端列表 + 全局密钥（localStorage 持久化；草稿只在内存） */
@Injectable({ providedIn: 'root' })
export class BackendsService {
  readonly backends = signal<Backend[]>(this.load());
  readonly globalKey = signal<string>(localStorage.getItem(STORE_KEY) ?? '');

  /** 已持久化（非草稿）的后端，供顶栏渲染 */
  readonly persisted = computed(() => this.backends().filter((b) => !b.draft));

  private load(): Backend[] {
    let raw: unknown = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORE_BACKENDS) ?? 'null');
    } catch {
      raw = null;
    }
    if (!Array.isArray(raw) || !raw.length) return DEFAULT_BACKENDS.map((b) => ({ ...b }));
    const clean = (raw as Backend[])
      .map((x) => ({ name: x?.name || '后端', api: (x?.api || '').trim(), key: x?.key || '' }))
      .filter((x) => x.api);
    if (clean.length !== raw.length) localStorage.setItem(STORE_BACKENDS, JSON.stringify(clean));
    return clean.length ? clean : DEFAULT_BACKENDS.map((b) => ({ ...b }));
  }

  private persist(): void {
    const list = this.backends()
      .filter((b) => !b.draft)
      .map((b) => ({ name: b.name, api: b.api, key: b.key }));
    localStorage.setItem(STORE_BACKENDS, JSON.stringify(list));
  }

  setGlobalKey(v: string): void {
    this.globalKey.set(v.trim());
    if (v.trim()) localStorage.setItem(STORE_KEY, v.trim());
  }

  keyFor(b: Backend): string {
    return (b.key || '').trim() || this.globalKey();
  }

  valid(b: Backend): boolean {
    return /^https?:\/\/.+/.test(b.api || '');
  }

  addDraft(): number {
    const next = [...this.backends(), { name: '新后端', api: '', key: '', draft: true }];
    this.backends.set(next);
    return next.length - 1;
  }

  save(i: number, name: string, api: string, key: string): boolean {
    const a = api.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(a)) return false;
    const next = this.backends().map((b, idx) =>
      idx === i ? { name: name.trim() || '后端' + (i + 1), api: a, key } : { ...b },
    );
    this.backends.set(next);
    this.persist();
    return true;
  }

  remove(i: number): void {
    const b = this.backends()[i];
    this.backends.set(this.backends().filter((_, idx) => idx !== i));
    if (!b?.draft) this.persist();
  }
}