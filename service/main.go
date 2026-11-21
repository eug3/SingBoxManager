package main

// vault-edit — 规则桶发布 + 内网管理台 + 路由配置通道（SingBoxManager 的 99 号机服务）
//
// 只监听内网（192.168.31.99:9099 / 10.1.1.99:9099），公网入口看不到本服务。
//
// 路由表（实现分散在同包各文件）：
//   GET  /health                     健康与配置自检            main.go
//   GET  /edit/                      Angular 管理台（SPA）     files.go
//   GET  /static/                    Monaco 等本地静态资源     files.go
//   GET  /rule-set/<桶>.{json,srs}   NAS 规则桶只读源（SMB/SFTP）files.go
//   GET  /share/health               文件通道+公网 URL 体检     share_health.go
//   POST /publish                    规则桶校验+编译+写回 NAS  publish.go
//   GET  /router/config              读路由 config.json        router_http.go
//   POST /router/check               路由上跑 sing-box check   router_http.go
//   POST /router/apply               备份→替换→重启→健康→回滚  router_http.go
//   POST /router/restart             仅重启 sing-box           router_http.go
//   GET|POST|DELETE /router/credentials  路由 SSH 凭据管理     router_store.go
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
)

func main() {
	if vaultKey == "" {
		log.Fatal("VAULT_KEY 未设置（应为两台路由 clash_api secret；systemd 从 /etc/vault-edit.env 注入）")
	}
	// 启动即探一次共享（SMB 首次连接稍慢，但不阻塞服务对外）
	if files, err := shareFS.List(); err != nil {
		log.Printf("警告：规则桶共享当前不可用（%s）：发布接口会返回 503；错误：%v", shareFS.Describe(), err)
	} else {
		log.Printf("规则桶共享就绪：%s（%d 个文件）", shareFS.Describe(), len(files))
	}

	mux := http.NewServeMux()

	// 健康自检：目录与凭据文件是否就绪（check.sh / 部署脚本断言用）
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_, rerr := os.Stat(routersFile())
		shareInfo, shareErr := shareFS.List()
		writeJSON(w, 200, map[string]any{
			"ok": true, "lang": "go", "share": shareFS.Describe(), "page": pageDir, "static": staticDir,
			"routers": routersFile(), "routersReady": rerr == nil,
			"shareReady": shareErr == nil, "shareFiles": len(shareInfo), "shareError": errText(shareErr),
		})
	})

	// 根路径 → 管理台
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/edit/", http.StatusFound)
	})

	// 静态三类
	mux.HandleFunc("GET /edit/", servePage)
	mux.HandleFunc("GET /edit/index.html", servePage)
	mux.HandleFunc("GET /static/", serveStatic)
	mux.HandleFunc("GET /rule-set/", serveRuleSet)

	// 存储（SMB/SFTP/本地）与公网读取通道体检：顶栏状态点用
	mux.HandleFunc("GET /share/health", handleShareHealth)

	// 规则桶发布
	mux.HandleFunc("/publish", handlePublish)

	// 路由配置通道（99 侧编排：SSH 上传候选配置 + 内联脚本，路由无需预装任何东西）
	mux.HandleFunc("GET /router/config", handleRouterConfig)
	mux.HandleFunc("POST /router/restart", handleRouterRestart)
	mux.HandleFunc("POST /router/check", handleRouterCheck)
	mux.HandleFunc("POST /router/apply", handleRouterApply)
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

	srv := &http.Server{Addr: listen, Handler: mux}
	log.Printf("vault-edit (go) listening on %s · share=%s · page=%s · static=%s", listen, shareDir, pageDir, staticDir)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
