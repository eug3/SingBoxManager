# 计划：远程 VPS 管理 + masque server 一键部署

> 2026-11-29 提出。目标：控制台顶部「共享编辑」旁新增「🛰 远程 VPS」；
> 浏览器填主机与凭据 → 99 的 Go 服务 SSH 过去 → 自动部署 sing-box **masque server**
> → 部署成功自动把对应 **masque-client** 节点写进**共享节点池**。

## 1. 现状（事实依据）

masque server 目前是 2026-11-15 **手工**部署在 7 台上（配方见 OpenViking 笔记
`masque-deployment-20261115.md`），每台差异不小：

| 服务器 | 节点名 | 地址池 | 证书 | 备注 |
|---|---|---|---|---|
| 146.56.103.38 | skn-sec | 172.20.0.1/24 | 自签 | nginx 占 TCP 443 |
| 152.69.225.85 | skn-one | 172.20.5.1/24 | 自签 | 原 V2Ray QUIC 让位到 8443 |
| 132.226.236.222 | arm.vmess | 172.20.1.1/24 | Let's Encrypt | aarch64 |
| 47.91.10.219 | ali.vmess | 172.20.2.1/24 | Let's Encrypt | 阿里云安全组要放行 UDP 443 |
| 35.212.140.196 | g.t | 172.20.3.1/24 | 自签 | Caddy 需关 HTTP/3 让出 UDP 443 |
| 147.224.61.121 | sa.vmess / v6.sa.vmess | 172.20.4.1/24 | 自签 | 同机双节点（v4 + v6） |

统一的落点与形状：

```text
/opt/sing-box-masque/sing-box          # 1.15.0-alpha.x（1.14 不支持 masque）
/etc/sing-box-masque/config.json
/etc/systemd/system/sing-box-masque.service
```

```json
{ "type": "masque-server", "tag": "masque-server", "listen": "::", "listen_port": 443,
  "version": [3], "users": [{"username": "masque", "password": "…"}],
  "tls": { "enabled": true, "certificate_path": "…", "key_path": "…", "server_name": "…" },
  "address": ["172.20.X.1/24"], "advertise_routes": ["0.0.0.0/0", "::/0"], "mtu": 1280 }
```

路由器侧对应 `endpoints[]` 里的 client：

```json
{ "type": "masque-client", "tag": "节点名", "server": "域名或 IP", "server_port": 443,
  "username": "masque", "password": "…", "version": 3,
  "tls": { "enabled": true, "server_name": "…", "insecure": true }, "mtu": 1280 }
```

**已知坑**（脚本要覆盖）：云安全组/本机防火墙要放行 UDP 443；Caddy 的 HTTP/3 会占 UDP 443；
Cloudflare 代理不转发 UDP（域名必须直连 A 记录）；时间偏差会导致隧道异常。

## 2. 可复用件（不重复造）

| 能力 | 现有实现 | 复用方式 |
|---|---|---|
| SSH 执行 | `router_ssh.go` 的 `sshDial` / `sshExec` / `sshExecOnce` | 已是通用（host/port/user/password + 超时 + 仅对拨号重试），VPS 直接用 |
| 二进制来源 | `version.go` 的 `versionCachePath` / `scanVersionCache` / `extractBinaryFromTarGz` | **从 99 的缓存上传**，不在 VPS 侧下载（避免被墙、版本可控） |
| 凭据存储 | `db.go` 的 `routers` 表 + `router_store.go` 三接口 | VPS 表照抄结构 |
| 共享池写入 | `shared-pool.service.ts` 的 `addNode(source, node, kind)` | 部署结果直接喂给它（`kind='endpoint'`） |
| 顶部 tab | `app.html` 右侧三枚 tab | 新增第四枚 |

## 3. 架构

```text
浏览器（新 tab：远程 VPS）
  │  POST /vps/preview   → 只回脚本全文（dry-run，不连 VPS）
  │  POST /vps/deploy    → 真执行
  ▼
99 Go 服务（vps.go / vps_deploy.go）
  │  ① 取 99 缓存的 sing-box 二进制（按 VPS 的 arch/libc 选 musl/glibc）
  │  ② SSH 上传二进制 + 脚本，分步执行、逐步回传
  │  ③ 回读校验：systemd active、UDP 端口监听、config check
  │  ④ 生成 masque-client endpoint JSON
  ▼
VPS（/opt/sing-box-masque + /etc/sing-box-masque + systemd）
  │
  └──► 浏览器拿到 endpoint → shared-pool.addNode() → 共享节点池
```

## 4. 数据模型（SQLite `vps` 表）

| 字段 | 说明 |
|---|---|
| `host` (PK) / `port` / `user` / `password` | SSH 连接；密码只写不读（GET 回 masked） |
| `name` | 显示名（也用来生成默认节点 tag） |
| `sni` / `cert_mode` | 服务端证书名；`self`（自签）/`existing`（复用已有路径）/`acme`（P2） |
| `listen_port` | 默认 443（UDP） |
| `addr_pool` | 地址池，默认按已用池自动分配下一个 `172.20.N.1/24` |
| `state` | `new` / `deployed` / `failed` |
| `last_deploy_at` / `last_error` ` / last_log` | 台账 |
| `node_json` | 部署成功后生成的 client endpoint（池子导入用） |

密码与 router 凭据同口径：SQLite 0600 明文、界面不回显。**不写进日志**。

## 5. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/vps/list` | 清单（密码 masked）+ 99 缓存里可用的 sing-box 版本 |
| POST | `/vps/save` | 新增/更新一台 |
| DELETE | `/vps?host=` | 删除（**只删台账，不卸载远端**） |
| POST | `/vps/preview` | 返回将要执行的脚本全文 + 预估步骤（dry-run） |
| POST | `/vps/deploy` | 真执行；同步返回 `{ok, steps[], log, node}` |
| POST | `/vps/probe` | 只连不装：探测 arch/libc/已装版本/UDP 端口占用 |

鉴权沿用 `/router/*` 口径（`X-Vault-Key` 或登录会话），并在 `main.go` 路由表里登记。

## 6. 部署脚本（幂等，分步）

1. **探测**：`uname -m`、`ldd --version`→glibc 或 `ls /lib/ld-musl*`→musl、`id -u`、systemd 是否存在
2. **备份**：已有 `config.json` → `config.json.bak-<ts>`（**不覆盖用户改过的**）
3. **装二进制**：`/opt/sing-box-masque/sing-box`，先写 `.new` 再 `mv`；`sing-box version` 校验
4. **证书**：自签用 `sing-box generate tls-keypair <sni>`（不依赖 openssl）→ `/etc/sing-box-masque/{cert,key}.pem`
5. **写配置**：masque-server（端口 / 地址池 / 用户密码 / SNI）
6. **校验**：`sing-box check -c config.json`，失败即停（远端保持原样）
7. **systemd**：写 unit → `daemon-reload` → `enable --now`
8. **验证**：`systemctl is-active`、`ss -lunp | grep :<port>`，失败回滚（停服务 + 还原 config）
9. **提示**（只报告不改动）：云安全组要放行 UDP 端口、若 443 被 caddy/nginx 占用则提示关 h3

参数一律**单引号转义**后再插入脚本（防注入）；密码不出现在 `ps` 可见位置（走 stdin 或 env）。

## 7. 共享池集成

- 后端返回的 endpoint 即第 1 节里的 client 形状（`insecure: true`、`mtu: 1280`）
- 前端调用 `addNode({ api: 'vps:' + host, name: 'VPS ' + name }, node, 'endpoint')`
- tag 冲突：池内同来源同 tag → 覆盖；**跨来源同名 → 自动加 `-<短后缀>` 并提示**
- 已部署过的再点部署：保留原密码/端口（只重装二进制与配置），并刷新池条目

## 8. 安全护栏

- 部署**只由用户点击**触发；先 `preview` 看脚本，再 `deploy`
- 后台**不自动**开云安全组、不改 iptables 默认策略、不碰 nginx/caddy 配置（只提示）
- 密码：只写不读、不进日志、不进 `ps`
- `DELETE /vps` 只删台账，远端卸载作为单独动作（P2，带确认）
- 所有远端写操作都先备份、失败即回滚

## 9. 分阶段

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| **P0** | 后端：`vps` 表、6 个接口、脚本生成 + 单测；组装/上传/执行/校验 | 单测覆盖脚本注入、配置合法性；preview 可用 |
| **P1** | 前端：第 4 枚 tab、清单+表单、preview 弹窗、部署进度、写池 | 浏览器里能跑完 dry-run；真机跑通一台 |
| **P2** | 台账（历史/错误）、批量部署、远端卸载与恢复 | 卸载后远端无残留 |
| **P3** | ACME 证书、多用户、定时健康探活 | 按需 |

## 10. 验证计划

1. **Go 单测**：脚本生成（含恶意参数注入用例）、masque-server 配置结构、client endpoint 结构、
   地址池/tag 自动分配、端口占用提示分支
2. **前端单测**：`buildPoolNodeFromDeploy()` 纯函数（tag 冲突后缀、kind 判定）
3. **dry-run**：UI 里 preview 出脚本全文，人工核对
4. **真机**：首个目标需用户指定。推荐先用**一台可弃的** VPS，或 99 本机以非 443 端口
   （如 24443）做受控验证，验证后 `systemctl disable --now` 并清理目录

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 云安全组没放行 UDP | 脚本只能检测本机监听；结果里明确提示去放行 |
| Caddy/nginx 占 UDP 443 | 部署前检测端口占用，冲突则建议换端口或关 h3 |
| 自签证书中间人风险 | 客户端 `insecure: true`（与现网一致），文档标注；P3 上 ACME |
| root 密码落 SQLite | 与 router 凭据同口径（0600），界面不回显；P2 可加 `VAULT_KEY` 加密 |
| 误删远端 | `DELETE /vps` 只删台账；卸载单独动作 + 二次确认 |
| 部署到生产路由已有节点 | 只新增池条目，不动路由配置；要在路由生效仍需用户在「共享编辑」里套用 |