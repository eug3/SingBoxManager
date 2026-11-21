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

var filesSrv = &filesListener{}

type filesListener struct {
	mu   sync.Mutex
	addr string
	srv  *http.Server
	ln   net.Listener
}

func defaultFilesListen() string { return env("FILES_LISTEN", ":9098") }

// handleFilesRuleSet 只读桶文件（与主服务同源实现，但只允许 GET/HEAD）
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
	if strings.HasSuffix(name, ".json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Access-Control-Allow-Origin", "*") // 只读，允许任意来源取规则
	w.Header().Set("Cache-Control", "no-store")
	if info != nil && !info.ModTime().IsZero() {
		w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(data)
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

// apply 启动或热重启文件服务监听（addr 为空则不启）
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
		f.srv, f.ln = nil, nil
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
	f.srv, f.ln, f.addr = srv, ln, addr
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
