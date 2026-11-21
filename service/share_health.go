package main

// share_health.go — 存储与公网读取通道体检：GET /share/health
//
// 顶栏那个状态点用的就是它：只检查「文件通道（SMB / SFTP / 本地）」与
// 「公网 HTTP 读取 URL」是否可用，与路由 sing-box 配置无关。
//
// 检查项：
//   1. ShareFS.List()  → 文件通道可达、桶文件数量
//   2. ShareFS.Stat(样本文档) → 能不能读到具体文件与大小/时间
//   3. HTTP GET ${PUBLIC_BASE}/rule-set/<样本>.srs → 公网只读链路状态码与耗时
//
// 可选环境变量：PUBLIC_BASE（默认 https://router.guaishoudejia.com）、HEALTH_SAMPLE（默认 rs-tg.srs）

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func publicBase() string {
	return strings.TrimRight(env("PUBLIC_BASE", "https://router.guaishoudejia.com"), "/")
}
func healthSample() string { return env("HEALTH_SAMPLE", "rs-tg.srs") }

var healthClient = &http.Client{Timeout: 8 * time.Second}

// handleShareHealth 报告文件通道 + 公网 URL 状态
func handleShareHealth(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}

	type filePart struct {
		Mode    string `json:"mode"`
		OK      bool   `json:"ok"`
		Detail  string `json:"detail"`
		Files   int    `json:"files"`
		Sample  string `json:"sample"`
		Size    int64  `json:"size"`
		ModTime string `json:"mtime,omitempty"`
		Error   string `json:"error,omitempty"`
		MS      int64  `json:"ms"`
	}
	type httpPart struct {
		URL    string `json:"url"`
		OK     bool   `json:"ok"`
		Status int    `json:"status"`
		Model  string `json:"mtime,omitempty"`
		Size   int    `json:"size"`
		MS     int64  `json:"ms"`
		Error  string `json:"error,omitempty"`
	}

	t0 := time.Now()
	file := filePart{Mode: shareFS.Describe(), Sample: healthSample()}
	if files, err := shareFS.List(); err != nil {
		file.Error = err.Error()
	} else {
		file.Files = len(files)
		if info, serr := shareFS.Stat(healthSample()); serr != nil {
			file.Error = "读样本失败: " + serr.Error()
		} else {
			file.OK = true
			file.Size = info.Size()
			file.ModTime = info.ModTime().Format(time.RFC3339)
			file.Detail = fmt.Sprintf("%d 个文件 · 样本 %s %dB", file.Files, healthSample(), info.Size())
		}
	}
	file.MS = time.Since(t0).Milliseconds()

	url := publicBase() + "/rule-set/" + healthSample()
	h := httpPart{URL: url}
	t1 := time.Now()
	req, _ := http.NewRequest(http.MethodGet, url+"?probe="+fmt.Sprint(t1.UnixNano()), nil)
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := healthClient.Do(req)
	if err != nil {
		h.Error = err.Error()
	} else {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		h.Status = resp.StatusCode
		h.Size = len(body)
		h.OK = resp.StatusCode == http.StatusOK && len(body) > 0
		h.Model = resp.Header.Get("Last-Modified")
	}
	h.MS = time.Since(t1).Milliseconds()

	writeJSON(w, 200, map[string]any{
		"ok":       file.OK && h.OK,
		"file":     file,
		"http":     h,
		"public":   publicBase(),
		"page":     pageDir,
		"localDir": os.Getenv("SHARE_DIR"),
	})
}
