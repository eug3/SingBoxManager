package main

// files_server.go — 单独的「规则桶只读文件服务」监听端口。
//
// 为什么要单独一个端口：文件是要对外/对内提供读取的，而管理台（/edit、/router/*、
// /publish）绝不能跟着暴露。所以这里只挂三样东西：
//
//   GET/HEAD /rule-set/<桶>.{json,srs}   只读桶文件
//   GET      /health                     极简健康（ok + files 数）
//   其它                                一律 404
//
// 端口来自存储配置（share.json 的 filesListen，默认环境变量 FILES_LISTEN=:9098），
// 保存配置时会热重启这个监听，不需要重启整个服务。
//
// 安全性：无写接口、无鉴权面、无目录浏览（桶名走正则白名单），CORS 放开只读 GET。

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// filesSrv 全局唯一的文件服务监听器（启动与保存配置时经 apply 热重启）
var filesSrv = &filesListener{}

// filesListener 独立文件端口的监听状态（mu 保护热重启与地址回显的并发）
type filesListener struct {
	mu   sync.Mutex
	addr string
	srv  *http.Server
}

// defaultFilesListen 文件服务默认监听地址（FILES_LISTEN 可覆盖）
func defaultFilesListen() string { return env("FILES_LISTEN", ":9098") }

// handleFilesRuleSet 只读桶文件（与主服务同源实现，但只允许 GET/HEAD）。
// 与主服务的差别：错误用纯文本 http.Error，且 CORS 放开任意来源（只读规则）。
func handleFilesRuleSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/rule-set/")
	if !rsFileRe.MatchString(name) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	data, info, err := currentShareFS().ReadFile(name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*") // 只读，允许任意来源取规则
	writeRuleSetData(w, r, name, data, info)
}

// filesMux 文件服务专用路由（刻意极简）
func filesMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		files, err := currentShareFS().List()
		resp := map[string]any{"ok": err == nil, "role": "files", "files": len(files)}
		if err != nil {
			resp["error"] = err.Error()
		}
		writeJSON(w, 200, resp)
	})
	mux.HandleFunc("GET /rule-set/", handleFilesRuleSet)
	mux.HandleFunc("HEAD /rule-set/", handleFilesRuleSet)
	// 其余路径一律 404，绝不暴露 /edit /router /publish
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	})
	return mux
}

// apply 启动或热重启文件服务监听（addr 为空则停用）。
// 地址未变且已在跑 → 直接返回；否则先 3s 优雅关停旧监听再绑新地址。
// 绑定失败返回 error（调用方只记日志，不影响主服务）。
func (f *filesListener) apply(addr string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	addr = strings.TrimSpace(addr)
	if addr == f.addr && f.srv != nil {
		return nil
	}
	// 先关旧监听
	if f.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = f.srv.Shutdown(ctx)
		cancel()
		f.srv = nil
	}
	f.addr = ""
	if addr == "" {
		log.Printf("文件服务未启用（filesListen 为空）")
		return nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("文件服务监听 %s 失败：%v", addr, err)
		return fmt.Errorf("文件服务监听 %s 失败: %w", addr, err)
	}
	srv := &http.Server{Handler: filesMux(), ReadHeaderTimeout: 10 * time.Second}
	f.srv, f.addr = srv, addr
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("文件服务退出：%v", err)
		}
	}()
	log.Printf("文件服务（只读桶）监听 %s", addr)
	return nil
}

// current 当前监听地址（给 /health 与页面回显）
func (f *filesListener) current() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addr
}
