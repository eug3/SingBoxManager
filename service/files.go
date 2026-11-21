package main

// files.go — 三类静态文件服务：
//   /rule-set/<桶>.{json,srs}  NAS 规则桶只读源（路由 60s 拉取的就是这里）
//   /edit/                     Angular 管理台（SPA，未知路径回退 index.html）
//   /static/                   Monaco 编辑器等本地静态资源（不依赖 CDN）

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// serveRuleSet 只读桶源：白名单文件名，no-store（路由侧自带 60s 缓存周期）。
// 数据经 ShareFS 取（默认纯 Go SMB2 → NAS，不需要任何挂载）。
func serveRuleSet(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/rule-set/")
	if !rsFileRe.MatchString(name) {
		fail(w, 404, "bad rule-set name")
		return
	}
	data, info, err := shareFS.ReadFile(name)
	if err != nil {
		fail(w, 404, "not found: "+err.Error())
		return
	}
	if strings.HasSuffix(name, ".json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "no-store")
	if info != nil && !info.ModTime().IsZero() {
		w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// servePage 管理台 SPA：存在的文件直接给，其余路径回退 index.html（前端路由）。
// 页面文件在磁盘上，改页面只需 deploy_console.sh，不用重编/重启本服务。
func servePage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	rel := strings.TrimPrefix(r.URL.Path, "/edit/")
	if rel != "" && rel != "index.html" {
		if f, err := safeJoin(pageDir, rel); err == nil {
			if st, err := os.Stat(f); err == nil && st.Mode().IsRegular() {
				http.ServeFile(w, r, f)
				return
			}
		}
	}
	http.ServeFile(w, r, filepath.Join(pageDir, "index.html"))
}

// serveStatic 本地静态资源（Monaco 的 AMD loader 与 worker 等），可长缓存
func serveStatic(w http.ResponseWriter, r *http.Request) {
	f, err := safeJoin(staticDir, strings.TrimPrefix(r.URL.Path, "/static/"))
	if err != nil {
		fail(w, 404, "bad path")
		return
	}
	st, err := os.Stat(f)
	if err != nil || !st.Mode().IsRegular() {
		fail(w, 404, "not found")
		return
	}
	switch {
	case strings.HasSuffix(f, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(f, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(f, ".json"):
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, f)
}
