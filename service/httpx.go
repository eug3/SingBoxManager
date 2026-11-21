package main

// httpx.go — HTTP 公共工具：JSON 应答、CORS、预检、路径安全。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// writeJSON 统一 JSON 应答（显式 Content-Length，方便脚本断言）
func writeJSON(w http.ResponseWriter, code int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	w.WriteHeader(code)
	w.Write(b)
}

// fail 统一错误应答：{"error": "..."}（前端 errMsg() 按这个结构取文案）
func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

// setCors 只对白名单来源回 ACAO；管理台接口一律 no-store
func setCors(h http.Header, origin string) {
	for _, o := range allowOrigins {
		if o == origin {
			h.Set("Access-Control-Allow-Origin", o)
			break
		}
	}
	h.Set("Access-Control-Allow-Headers", "Content-Type,X-Vault-Key")
	h.Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	h.Set("Cache-Control", "no-store")
}

// preflight 设置 CORS 头并处理 OPTIONS 预检。
// 返回 true 表示预检已应答（204），handler 应直接 return。
func preflight(w http.ResponseWriter, r *http.Request) bool {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	return false
}

// safeJoin 拼接并防目录穿越（base 之外的路径一律拒绝）
func safeJoin(base, rel string) (string, error) {
	full := filepath.Join(base, filepath.Clean("/"+rel))
	baseClean := filepath.Clean(base)
	if full != baseClean && !strings.HasPrefix(full, baseClean+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escape: %s", rel)
	}
	return full, nil
}

// errText 把 error 转成字符串（nil → ""），给 /health 用
func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// trunc 保留末尾 n 字节（编译报错等长输出的尾部信息最有价值）
func trunc(b []byte, n int) []byte {
	if len(b) > n {
		return b[len(b)-n:]
	}
	return b
}
