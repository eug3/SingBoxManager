# HANDOFF · SingBoxManager 交接（2026-11-21 晚）

> 给下一个会话/机器：本目录是 SingBoxManager 的开发工作区。**先读 `docs/runbook.md`**（架构、桶清单、坑、凭据指路、回滚），再读本文。本仓库不是运行体——运行体在 NAS / 99号机 / 两台路由上，本仓库是它们的源码与运维工具。

## 系统现状（全部已上线并验证）

1. **规则全量远程化**（2026-11-21）：两台路由 172 条域名/IP 规则 → NAS 上 23 桶 + bard，60s 自动刷新；语义经域名+IP 双维 0 偏差验证；规则数 183/185 → 35/37。回滚：两台 `bak-20261121-before-bulk-remotes`
2. **发布/管理服务**（99号机，**Go**）：`systemd vault-edit` → `/usr/local/bin/vault-edit`，`:9099`；校验→编译→写回 NAS。密钥不再硬编码，改由 `/etc/vault-edit.env`(0600) 的 `VAULT_KEY` 注入
3. **管理台只在 99 内网**（2026-11-21 本轮）：`http://192.168.31.99:9099/edit/`
   - 页面 → `/usr/local/share/vault-edit/edit/index.html`（改页面只需重发，不重编二进制）
   - 桶源只读 → `GET /rule-set/<桶>.{json,srs}`（99 服务端读 NAS，同源无 CORS）
   - 发布 → `POST /publish`（`X-Vault-Key`）
   - **公网目录已摘除**：原 `WebEdit/edit/` → `HddShare/_bak-WebEdit-edit-20261121/`；公网 `router.guaishoudejia.com/edit/` 与内网 `888/edit/` 均 404，首页仍 200
4. **公网页面只读规则**（用户 2026-11-21 拍板）：`https://router.guaishoudejia.com/` = 脱敏首页 + `rule-set/` + `zashboard/`，不含任何管理入口
5. **前端已在 2026-11-21 重写为 Angular 22 + TypeScript**（`web/console/`，standalone/signals/zoneless，无 zone.js；规则编辑用 Monaco 0.57，静态托管在 99 的 `/static/monaco/vs`）。布局是两层横向 tab：主 tab = 后端 + 添加 + 规则编辑；后端内子 tab = 分组与节点/连接/日志/规则。构建 `npx ng build --base-href=/edit/`，部署 `ROUTER_PW=… scripts/deploy_console.sh`（整体替换 pageDir、自动备份 `edit.bak-<ts>`、Monaco 按 VERSION 跳过重复上传、**不需要重启 Go 服务**）。Go 侧新增 `/static/` 与 `/edit/` 的「命中文件即发、否则回落 index.html」。旧单文件页面 `web/edit/index.html` 仅留作回滚参考，不再部署。
5. **clash_api 由浏览器直连**：两台路由白名单**均已含三个来源** `888` / `http://192.168.31.99:9099`（LAN）/ `http://10.1.1.99:9099`（EasyTier）；未知来源无 ACAO。管理台两个入口等价：LAN `http://192.168.31.99:9099/edit/` 与 EasyTier `http://10.1.1.99:9099/edit/`（无头浏览器实测甲/乙/编辑三 tab 均正常，乙 tab 真实出 456 条连接/18 分组）
6. **EasyTier 恢复（2026-11-21 13:3x）**：真根因是 32 上 LuCI/Socat 那条 `备注11010` 的转发写成 `udp → tcp4`，把 UDP 握手扭成 TCP 并堆出 1063 个 socat 子进程 → 99 的 EasyTier 控制面活、数据面全死。已改 `dest_proto=udp4` + 清进程 + 重启 socat，再重启 99 easytier：socat 1063→38，99 peer 全 p2p 0% 丢包，99→GL 由 000 变 200
7. **CORS 底座**：两台原有 888 来源（zashboard 用，`bak-20261121-before-cors`）；本轮各加两来源，备份 `config.json.bak-20261121-133552/133603-before-easytier-origin`（回滚见 runbook §8）

## 本仓库 ↔ 运行体的对应

| 仓库文件 | 运行位置 | 部署命令 |
|---|---|---|
| `web/index.html` | NAS `WebEdit/index.html` | `scripts/deploy_web.sh` |
| `web/edit/index.html` | 99 `/usr/local/share/vault-edit/edit/index.html` | `scripts/deploy_service.sh`（随服务一起） |
| `service/`（Go: main.go + go.mod + unit） | 99 `/usr/local/bin/vault-edit` | `scripts/deploy_service.sh`（交叉编译+上传+写 env+重启） |
| （无）桶 json/srs | NAS `WebEdit/rule-set/` | 经 99 管理台或 `scripts/publish.sh` 发布 |

注意：**桶的 json 源不在本仓库**（在 NAS，是运行数据）；本仓库只管页面与服务代码。

## 还没做 / 待拍板（runbook §7 有完整清单与命令）

- ~~乙(GL) 放行来源~~ 已完成（2026-11-21 13:36）
- **轮换 clash secret / X-Vault-Key**（旧 key 曾以明文进入公开仓库 `eug3/SingBoxManager` 的提交历史；当前值见两台路由 config 与 99 的 env 文件）——用户决定「下一轮再换」
- **32 的 Socat 端口转发**：目前只有 11010 两条与 EasyTier 相关；若以后再加 udp 转发，务必 `dest_proto` 用 `udp4` 而不是 `tcp4`（见 runbook 坑 12）
- rule-set `.json` 源 + `manifest.json` 公网可下载的收口（A 移出 WebEdit / B 接受现状）
- fork zashboard 把规则编辑嵌入（发布 API 可直接复用）
- clash-api 9090 的 0.0.0.0 监听收窄、32 的 dns 收口漂移修复（长期待办）

## 环境速查

- 工作机：Mac（`~/Github/SingBoxManager`）；NAS SMB 自动挂 `/Volumes/HddShare`
- 99号机：`ssh beijihu@192.168.31.99`（**公钥已可用**；sudo 需口令，口令见 NAS 凭据登记表）；日志 `journalctl -u vault-edit`
- 路由：32 用 `ssh root@192.168.31.32`（口令见登记表）；GL 用 `ssh root@172.16.8.1`（Dropbear，仅密码；**99 到不了 GL，必须从能进 172.16.8.0/24 的机器操作**）
- 凭据权威表：`\\192.168.31.8\HddShare\credentials\dev-and-test-password.txt`（仓库与页面一律不落密钥）
- OpenViking 记忆卡：`路由器remote-rule-set托管`（权威）、`GL-BE3600_172.16.8.1_sing-box`、`openwrt主路由sing-box`、`rinetd`

## 下一步建议

1. 日常按 runbook §3 走（管理台改桶 → 发布 → 验证）
2. 若要动桶结构（增删桶/挪顺序）：必须重跑域名+IP 双维等价验证（历史踩坑：纯 IP 规则在域名测试下是零测试假象）
3. 本轮改动**尚未 git 提交**（按约定由你决定提交与信息）；提交前注意 `docs/` 与 `HANDOFF.md` 里已不含明文口令/密钥
4. 仓库当前是公开仓：任何密钥、口令、真实拓扑细节都不要落进提交