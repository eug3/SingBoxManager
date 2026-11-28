import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BackendsService } from './backends.service';

/** 99 上缓存的一个 sing-box 包（版本 + 架构） */
export interface CachedVersion {
  version: string;
  arch: string;
  /** "" = 官方默认包（glibc 动态）；musl / glibc = 指定变体。OpenWrt/GL.iNet 必须 musl */
  variant: string;
  size: number;
  sha256?: string;
  at?: string;
  source?: string;
}

/** 一台受管路由的 sing-box 版本现状（只读探测结果） */
export interface RouterVersion {
  host: string;
  name?: string;
  /** amd64 / arm64 …（已从 uname -m 归一） */
  arch: string;
  /** musl / glibc / ""：决定该用哪个变体的包 */
  libc: string;
  /** 当前运行的版本；空 = 没探到 */
  version: string;
  bin: string;
  binMB: number;
  /** 二进制所在分区可用空间（MB） */
  freeMB: number;
  /** 是否已有 .prev.gz 备份 */
  backup: boolean;
  error: string;
}

/** 官方 tag 列表里的一项 */
export interface ReleaseItem {
  version: string;
  tag: string;
  prerelease: boolean;
  /** alpha / beta / rc / stable */
  note: string;
}

export interface VersionListResp {
  ok: boolean;
  cacheDir: string;
  disk: { freeMB: number; totalMB: number };
  local: CachedVersion[];
  routers: RouterVersion[];
  mirrors: string[];
}

export interface DeployResp {
  ok?: boolean;
  error?: string;
  host: string;
  version: string;
  arch: string;
  before: string;
  after: string;
  sizeMB: number;
  uploadSecs: number;
  secs: number;
  backup: boolean;
  freeMB: number;
  log: string;
}

/**
 * sing-box 版本管理：99 下载缓存 → 部署到受管路由。
 *
 * 密钥口径与其它 /router/* 一致：带 X-Vault-Key（页面里用第一个后端的 clash secret，
 * 与 router.service 的 headers() 同源），99 侧校验通过即可。
 */
@Injectable({ providedIn: 'root' })
export class VersionService {
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);

  private headers(): HttpHeaders {
    const list = this.backends.backends();
    const key = list.length ? this.backends.keyFor(list[0]) : '';
    return new HttpHeaders({ 'X-Vault-Key': key, 'Content-Type': 'application/json' });
  }

  /** 路由现状 + 99 缓存清单 */
  list(): Promise<VersionListResp> {
    return firstValueFrom(
      this.http.get<VersionListResp>('/router/versions', { headers: this.headers() }),
    );
  }

  /** 官方版本列表（服务端 10 分钟缓存；refresh 强制刷新） */
  available(refresh = false): Promise<{ ok: boolean; releases: ReleaseItem[]; cached: Record<string, boolean>; warning?: string }> {
    const url = refresh ? '/router/versions/available?refresh=1' : '/router/versions/available';
    return firstValueFrom(
      this.http.get<{ ok: boolean; releases: ReleaseItem[]; cached: Record<string, boolean>; warning?: string }>(url, {
        headers: this.headers(),
      }),
    );
  }

  /** 下载某个版本 + 架构到 99（走镜像，约 15–40 秒） */
  download(version: string, arch: string, variant: string, force = false): Promise<{ ok: boolean; cached?: boolean; size?: number; secs?: number; source?: string }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean; cached?: boolean; size?: number; secs?: number; source?: string }>(
        '/router/versions/download',
        { version, arch, variant, force },
        { headers: this.headers() },
      ),
    );
  }

  /** 部署到某台路由（上传 → 校验 → 备份 → 替换 → check → 重启 → 健康；失败自动回滚） */
  deploy(host: string, version: string, arch: string, variant: string): Promise<DeployResp> {
    return firstValueFrom(
      this.http.post<DeployResp>('/router/versions/deploy', { host, version, arch, variant }, { headers: this.headers() }),
    );
  }

  /** 从 99 缓存里删掉一个包 */
  remove(version: string, arch: string, variant: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/router/versions/remove', { version, arch, variant }, { headers: this.headers() }),
    );
  }
}