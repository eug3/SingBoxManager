package main

// share_health.go — 存储与公网读取通道体检：GET /share/health
//
// 顶栏那个状态点用的就是它：只检查「文件通道（SMB / SFTP / 本机目录）」与
// 「公网 HTTP 读取 URL」是否可用，与路由 sing-box 配置无关。
//
// 检查项：
//   1. ShareFS.List()          文件通道可达 + 桶文件数量
//   2. ShareFS.Stat(样本文档)   能不能读到具体文件、大小与修改时间
//   3. GET ${PUBLIC_BASE}/rule-set/<样本>  公网只读链路的状态码、字节数与耗时
//
// 同一个函数也供页面齿轮里的「测试」（POST /share/probe）用，
// 只是那时传入的是「候选配置」，不落盘。

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

var healthClient = &http.Client{Timeout: 8 * time.Second}

// probeShare 用给定后端与公网地址做一次体检
func probeShare(fs ShareFS, publicBase, sample string) map[string]any {
	if sample == "" {
		sample = "rs-tg.srs"
	}
	publicBase = normalizePublicBase(publicBase)

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
		Mtime  string `json:"mtime,omitempty"`
		Size   int    `json:"size"`
		MS     int64  `json:"ms"`
		Error  string `json:"error,omitempty"`
	}

	// —— 1/2. 文件通道 ——
	t0 := time.Now()
	file := filePart{Mode: fs.Describe(), Sample: sample}
	if files, err := fs.List(); err != nil {
		file.Error = err.Error()
	} else {
		file.Files = len(files)
		if info, serr := fs.Stat(sample); serr != nil {
			file.Error = "读样本失败: " + serr.Error()
		} else {
			file.OK = true
			file.Size = info.Size()
			file.ModTime = info.ModTime().Format(time.RFC3339)
			file.Detail = fmt.Sprintf("%d 个文件 · 样本 %s %dB", file.Files, sample, info.Size())
		}
	}
	file.MS = time.Since(t0).Milliseconds()

	// —— 3. 公网 URL ——
	var h httpPart
	if publicBase != "" {
		h.URL = publicBase + sample
		t1 := time.Now()
		req, _ := http.NewRequest(http.MethodGet, h.URL+"?probe="+fmt.Sprint(t1.UnixNano()), nil)
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
			h.Mtime = resp.Header.Get("Last-Modified")
		}
		h.MS = time.Since(t1).Milliseconds()
	} else {
		h.Error = "公网地址未配置（PUBLIC_BASE）"
	}

	return map[string]any{
		"ok":     file.OK && h.OK,
		"file":   file,
		"http":   h,
		"public": publicBase,
		"page":   pageDir,
	}
}

// handleShareHealth 报告当前生效配置下的文件通道 + 公网 URL 状态
func handleShareHealth(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	cfg := currentShareCfg()
	resp := probeShare(currentShareFS(), cfg.PublicBase, cfg.Sample)
	resp["mode"] = cfg.Mode
	resp["localDir"] = cfg.Local.Dir
	writeJSON(w, 200, resp)
}
