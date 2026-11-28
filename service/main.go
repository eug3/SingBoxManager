package main

// vault-edit — 规则桶发布 + 内网管理台 + 路由配置通道（SingBoxManager 的 99 号机服务）
//
// 只监听内网（192.168.31.99:9099 / 10.1.1.99:9099），公网入口看不到本服务。
//
// 路由表（实现分散在同包各文件）：
//   GET  /health                     健康与配置自检            main.go
//   GET  /login                      单口令登录页（一周免登录）  login.go
//   POST /login                      校验口令 → 下发会话 Cookie login.go
//   GET|POST /logout                 退出登录（清 Cookie）      login.go
//   GET  /                           302 → /edit/              main.go
//   GET  /edit/                      Angular 管理台（SPA）     files.go
//   GET  /static/                    Monaco 等本地静态资源     files.go
//   GET  /rule-set/index             规则桶清单（名字+大小/时间）  buckets.go
//   POST /rule-set/create            新建空桶（只写 .json，需密钥） buckets.go
//   POST /rule-set/rename            重命名桶（.json+.srs 一起搬） buckets.go
//   GET  /rule-set/<桶>.{json,srs}   NAS 规则桶只读源（SMB/SFTP）files.go
//   DELETE /rule-set/<桶>.json       删桶（.json+.srs，需密钥）files.go
//   GET  /share/health               文件通道+公网 URL 体检     share_health.go
//   GET|POST /share/config           存储配置读/写（热生效）    sharecfg.go
//   POST /share/probe                候选配置试连（不落盘）     sharecfg.go
//   POST /share/import               桶文件复制到本机 local     sharecfg.go
//   GET  /public/rules/preview       公网入口改写预览           public_rules.go
//   POST /public/rules/apply         公网入口改写写入路由       public_rules.go
//   GET  /db/info                    SQLite 表行数与最近动作    main.go
//   POST /publish                    规则桶校验+编译+写回 NAS  publish.go
//   GET  /router/config              读路由 config.json        router_http.go
//   GET  /router/rules               路由规则结构摘要          rules_summary.go
//   GET  /router/clients             LAN 客户端名册(IP→MAC)    router_clients.go
//   POST /router/check               路由上跑 sing-box check   router_http.go
//   POST /router/apply               备份→替换→重启→健康→回滚  router_http.go
//   POST /router/restart             仅重启 sing-box           router_http.go
//   GET|POST|DELETE /router/credentials  路由 SSH 凭据管理     router_store.go
//
// 另有独立只读文件端口（默认 :9098，见 files_server.go）：只挂 /rule-set/ 与 /health。
//
// 鉴权：
//   /publish   只认 X-Vault-Key = VAULT_KEY；
//   /router/*  认 VAULT_KEY 或目标路由 clash_api 认可的 secret（见 router_http.go）。
//
// 部署：99 号机 /usr/local/bin/vault-edit（systemd: vault-edit.service，
//       EnvironmentFile=/etc/vault-edit.env），见 scripts/deploy_service.sh。

import (
	"log"
	"net/http"
	"os"
	"time"
)

// main 启动顺序：校验 VAULT_KEY → 打开 SQLite（含旧文件迁移）→ 热装存储配置
// → 启动独立文件端口 → 预探一次共享 → 挂路由并监听主端口。
// 除 VAULT_KEY 缺失外，其余初始化失败都只告警不退出（服务带病可用，体检接口暴露问题）。
func main() {
	if vaultKey == "" {
		log.Fatal("VAULT_KEY 未设置（应为两台路由 clash_api secret；systemd 从 /etc/vault-edit.env 注入）")
	}
	// 数据库：打开 + 建表 + 一次性迁移旧 JSON
	if ok, derr := dbHealthy(); !ok {
		log.Printf("警告：SQLite 不可用（%s）：%v", dbFile(), derr)
	} else {
		log.Printf("SQLite 就绪：%s", dbFile())
	}

	// 登录门：读 /etc/vault-edit/login.json（不存在则按默认口令 rvnc1984 创建）
	loadLogin()

	// 存储配置：读库（无记录则用 env 默认值），并热装到全局
	applyShareConfig(loadShareConfig())

	// 只读文件服务跑在独立端口（默认 :9098）：文件可对外，管理台不外露
	if err := filesSrv.apply(currentShareCfg().FilesListen); err != nil {
		log.Printf("警告：文件服务未启动：%v", err)
	}

	// 启动即探一次共享（SMB 首次连接稍慢，但不阻塞服务对外）
	if files, err := currentShareFS().List(); err != nil {
		log.Printf("警告：规则桶共享当前不可用（%s）：发布接口会返回 503；错误：%v", currentShareFS().Describe(), err)
	} else {
		log.Printf("规则桶存储就绪：%s（%d 个文件）", currentShareFS().Describe(), len(files))
	}

	mux := http.NewServeMux()

	// 健康自检：目录与凭据文件是否就绪（check.sh / 部署脚本断言用）
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_, rerr := os.Stat(routersFile())
		shareInfo, shareErr := currentShareFS().List()
		dbOK, dbMsg := dbHealthy()
		writeJSON(w, 200, map[string]any{
			"ok": true, "lang": "go", "share": currentShareFS().Describe(), "shareMode": currentShareCfg().Mode, "page": pageDir, "static": staticDir,
			"files": filesSrv.current(), "db": dbFile(), "dbOK": dbOK, "dbError": dbMsg,
			"routers": routersFile(), "routersReady": rerr == nil,
			"shareReady": shareErr == nil, "shareFiles": len(shareInfo), "shareError": errText(shareErr),
		})
	})

	// 登录（单口令；登录后一周免登录）
	mux.HandleFunc("GET /login", handleLoginPage)
	mux.HandleFunc("POST /login", handleLoginSubmit)
	mux.HandleFunc("GET /logout", handleLogout)
	mux.HandleFunc("POST /logout", handleLogout)

	// 根路径 → 管理台
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/edit/", http.StatusFound)
	})

	// 静态三类
	mux.HandleFunc("GET /edit/", servePage)
	mux.HandleFunc("GET /edit/index.html", servePage)
	mux.HandleFunc("GET /static/", serveStatic)
	mux.HandleFunc("GET /rule-set/index", handleRuleSetIndex)
	mux.HandleFunc("POST /rule-set/create", handleRuleSetCreate)
	mux.HandleFunc("POST /rule-set/rename", handleRuleSetRename)
	mux.HandleFunc("GET /rule-set/", serveRuleSet)
	mux.HandleFunc("DELETE /rule-set/", handleRuleSetDelete)

	// 存储（SMB/SFTP/本机目录）与公网读取通道体检：顶栏状态点用
	mux.HandleFunc("GET /share/health", handleShareHealth)
	mux.HandleFunc("GET /share/config", handleShareConfigGet)
	mux.HandleFunc("POST /share/config", handleShareConfigSet)
	mux.HandleFunc("POST /share/probe", handleShareProbe)
	mux.HandleFunc("POST /share/import", handleShareImport)

	// 公网只读入口 → 写进路由器规则（route.rule_set[].url）
	mux.HandleFunc("GET /public/rules/preview", handlePublicRulesPreview)
	mux.HandleFunc("POST /public/rules/apply", handlePublicRulesApply)

	// 数据库信息（表与行数，页面/体检用）
	mux.HandleFunc("GET /db/info", func(w http.ResponseWriter, r *http.Request) {
		if preflight(w, r) {
			return
		}
		// 只读统计，不含口令，开放
		st, err := dbStats()
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		st["publishes"] = recentPublishes(5)
		writeJSON(w, 200, st)
	})

	// 规则桶发布
	mux.HandleFunc("/publish", handlePublish)

	// 路由配置通道（99 侧编排：SSH 上传候选配置 + 内联脚本，路由无需预装任何东西）
	mux.HandleFunc("GET /router/config", handleRouterConfig)
	mux.HandleFunc("GET /router/rules", handleRouterRules)
	mux.HandleFunc("GET /router/clients", handleRouterClients)
	mux.HandleFunc("GET /router/apistatus", handleRouterAPIStatus)
	mux.HandleFunc("POST /router/restart", handleRouterRestart)
	mux.HandleFunc("POST /router/check", handleRouterCheck)
	mux.HandleFunc("POST /router/apply", handleRouterApply)
	// sing-box 版本管理：99 下载缓存 → 推送部署到路由（下载/删除不需要 host，部署按 host 鉴权）
	mux.HandleFunc("GET /router/versions", handleVersionList)
	mux.HandleFunc("GET /router/versions/available", handleVersionAvailable)
	mux.HandleFunc("POST /router/versions/download", handleVersionDownload)
	mux.HandleFunc("POST /router/versions/deploy", handleVersionDeploy)
	mux.HandleFunc("POST /router/versions/remove", handleVersionRemove)
	mux.HandleFunc("GET /router/credentials", handleRouterCredentialsList)
	mux.HandleFunc("POST /router/credentials", handleRouterCredentialsSet)
	mux.HandleFunc("DELETE /router/credentials", handleRouterCredentialsDelete)

	// 兜底 404（也处理跨域预检）
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if preflight(w, r) {
			return
		}
		fail(w, 404, "not found")
	})

	// 只读类超时（防 slowloris / 慢客户端占着连接）。
	// 注意**不设 WriteTimeout**：/router/apply、/router/versions/deploy 是同步的长请求
	// （备份→替换→重启→健康检查，实测几十秒到几分钟），一刀切的写超时会正当部署中途掐断。
	// IdleTimeout 让空闲 keep-alive 连接及时回收。
	srv := &http.Server{
		Addr:              listen,
		Handler:           loginGate(mux),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       2 * time.Minute, // 含请求体读取（apply 要收整份配置）
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("vault-edit (go) listening on %s · share=%s · page=%s · static=%s", listen, shareDir, pageDir, staticDir)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
