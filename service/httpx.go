package main

// httpx.go — HTTP 公共工具：JSON 应答、CORS、预检、路径安全。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// writeJSON 统一 JSON 应答：序列化 v → 设 Content-Type/显式 Content-Length → 写状态码与体。
// 显式 Content-Length 方便脚本断言。v 必须可 JSON 序列化（本服务只传 map/结构体，
// 序列化失败按空体处理，与历史行为一致）。
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

// setCors 只对白名单来源（allowOrigins）回 ACAO；管理台接口一律 no-store。
// 非白名单来源不设 ACAO（浏览器侧自然拦截），其余 CORS 头照常给。
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

// safeJoin 拼接并防目录穿越（containment：结果永远不逃出 base）。
// 机制：先把 rel 规范化为「绝对路径再 Clean」——Clean("/"+rel) 会把一切 ..
// 收敛到根，因此 ../ 攻击最多落到 base 本身；再做前缀校验兜底，
// 结果不等于 base 也不在 base/ 之下时返回 path escape 错误。
func safeJoin(base, rel string) (string, error) {
	full := filepath.Join(base, filepath.Clean("/"+rel))
	baseClean := filepath.Clean(base)
	if full != baseClean && !strings.HasPrefix(full, baseClean+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escape: %s", rel)
	}
	return full, nil
}

// sha256Hex 内容 sha256（配置乐观锁 / 变更比对用）
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
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

// readJSON 解析请求体 JSON 到 v，带大小上限。
// 所有接受 JSON 体的接口都应走这里：原先只有 buckets.go 两处加了 MaxBytesReader，
// 其余 11 处是裸 json.NewDecoder(r.Body)——一个连着发大 body 的请求就能把 99 的内存吃光。
// 上限说明：整份路由配置（含规则集定义）实测几十 KB；给 16MB 留足余量，
// 又远小于「无上限」。超限 / 解析失败统一回 400，文案与原各处一致。
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := decodeJSONLimited(r, v); err != nil {
		fail(w, 400, "bad body")
		return false
	}
	return true
}

// readJSONLenient 同 readJSON，但解析失败**不写应答**（只返回 false）。
// 给那些「body 可省略、缺字段由后面的校验给出更贴切错误」的接口用
// （如 /router/restart 可以不带 body）——用 readJSON 会先写一个 400 再被后续应答覆盖（双写）。
// 体积上限一样有。
func readJSONLenient(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeJSONLimited(r, v) == nil
}

// jsonBodyMax JSON 请求体上限：整份路由配置（含规则集定义）实测几十 KB，
// 16MB 留足余量又远小于「无上限」。
const jsonBodyMax = 16 << 20

func decodeJSONLimited(r *http.Request, v any) error {
	// 这里拿不到 ResponseWriter，用 io.LimitReader 截断即可（超限会截成坏 JSON → 解析失败）
	dec := json.NewDecoder(io.LimitReader(r.Body, jsonBodyMax+1))
	return dec.Decode(v)
}
