package main

// router_apistatus.go — GET /router/apistatus：用 sing-box 的 API 服务（gRPC，默认 9092）取
// clash_api 拿不到的运行时信息，补给「概述」页。
//
// 为什么不直连 gRPC：service/api 是 gRPC，浏览器拿不到 proto 也解析不了 protobuf；
// 而路由上装着 sing-box 二进制，它自带 `sing-box api` CLI（同一套 gRPC 客户端），
// 所以由 99 侧 SSH 执行 CLI、解析文本输出、回传 JSON —— 前端零协议负担。
//
// 口径：全部只读（status / outbounds / group list / mode），不触发测速与任何写操作。
// 失败（路由没开 API 服务、端口不通、老版本无该命令）一律降级为空值 + 原因，
// 前端据此隐藏卡片，不影响概览原有的 clash_api 数据。

import (
	"bufio"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// apiStatusResp /router/apistatus 应答
type apiStatusResp struct {
	OK        bool   `json:"ok"`
	Host      string `json:"host,omitempty"`
	State     string `json:"state,omitempty"`    // started / stopped
	Uptime    string `json:"uptime,omitempty"`   // 原样：1h48m47s
	UptimeS   int64  `json:"uptimeSec"`          // 解析成秒，前端做格式化
	MemoryMB  int64  `json:"memoryMB"`           // CLI 只给 MB 粒度
	Goroutine int    `json:"goroutines"`         // Go 协程数（clash_api 没有）
	ConnIn    int    `json:"connIn"`             // 入站连接数（clash_api 只有合并值）
	ConnOut   int    `json:"connOut"`            // 出站连接数
	UpRate    string `json:"upRate,omitempty"`   // 上行速率（CLI 原样，如 237 B/s）
	DownRate  string `json:"downRate,omitempty"` // 下行速率
	UpTotal   string `json:"upTotal,omitempty"`  // 累计上行（如 12 MB total）
	DownTotal string `json:"downTotal,omitempty"`
	// 出站/分组摘要：分组数、节点数、已选节点（来自 group list，比 /proxies 更轻）
	Groups   int               `json:"groups"`
	Nodes    int               `json:"nodes"`
	Selected map[string]string `json:"selected,omitempty"` // 分组 tag → 当前成员
	Version  string            `json:"version,omitempty"`
	Mode     string            `json:"mode,omitempty"`
	Err      string            `json:"err,omitempty"`
}

// apiStatusTimeRe 解析 uptime（1h48m47s / 3m2s / 47s）
var apiStatusTimeRe = regexp.MustCompile(`(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?`)

// parseUptime 把 sing-box api 的 uptime 串换成秒
func parseUptime(s string) int64 {
	m := apiStatusTimeRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0
	}
	var total int64
	if m[1] != "" {
		v, _ := strconv.ParseInt(m[1], 10, 64)
		total += v * 3600
	}
	if m[2] != "" {
		v, _ := strconv.ParseInt(m[2], 10, 64)
		total += v * 60
	}
	if m[3] != "" {
		v, _ := strconv.ParseInt(m[3], 10, 64)
		total += v
	}
	return total
}

// parseKV 把 `Key:   value` 的 CLI 输出解析成 map（键统一小写去空格）
func parseKV(out string) map[string]string {
	m := make(map[string]string, 12)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		i := strings.Index(line, ":")
		if i <= 0 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(line[:i]))
		v := strings.TrimSpace(line[i+1:])
		if k != "" {
			m[k] = v
		}
	}
	return m
}

// apiCLI 拼一条 `sing-box api <sub> --url --secret` 命令（secret 走 argv，仅在本机 SSH 会话内可见）
func apiCLI(secret string, args ...string) string {
	var b strings.Builder
	b.WriteString("/opt/sing-box/sing-box api ")
	b.WriteString(strings.Join(args, " "))
	b.WriteString(" --url=http://127.0.0.1:9092")
	if secret != "" {
		b.WriteString(" --secret=")
		b.WriteString(secret)
	}
	return b.String()
}

// remoteAPISecret 从路由 config.json 里取 services[type=api].secret（只读 grep，不解析整份配置）
func remoteAPISecret(host string, cred routerCred) string {
	out, err := sshExec(host, cred, "sed -n '/\"services\"/,/]/p' "+routerConfigPath()+
		" | grep -o '\"secret\"[^,}]*' | head -1 | sed 's/.*\"\\([^\"]*\\)\"$/\\1/'", nil, 15*time.Second)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
}

// handleRouterAPIStatus GET /router/apistatus?host=… —— sing-box API 服务的运行状态（只读）
func handleRouterAPIStatus(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	cred, host, err := pickRouter(r.URL.Query().Get("host"))
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	resp := apiStatusResp{Host: host}
	secret := remoteAPISecret(host, cred)

	// 一次 SSH 会话跑完全部 5 条命令：分 5 次连会多付 4 次握手（实测乙路由 4.6s → 这里压到 1s 量级）。
	// 每条之间打哨兵 `###<n>`，任一条失败只影响它自己那一段。
	script := apiCLI(secret, "status") + "; echo  \"###1\"; " +
		apiCLI(secret, "version") + "; echo \"###2\"; " +
		apiCLI(secret, "mode") + "; echo \"###3\"; " +
		apiCLI(secret, "outbounds") + "; echo \"###4\"; " +
		apiCLI(secret, "group", "list")
	out, err := sshExec(host, cred, script, nil, 30*time.Second)
	if err != nil {
		resp.Err = "API 服务不可用（路由未启用 service/api 或端口不通）"
		writeJSON(w, 200, resp) // 200 + err：前端按「该能力不可用」降级，不算请求失败
		return
	}
	secs := splitSections(out)
	statusOut := secs[0]
	if strings.TrimSpace(statusOut) == "" {
		resp.Err = "API 服务无应答"
		writeJSON(w, 200, resp)
		return
	}
	kv := parseKV(statusOut)
	resp.OK = true
	resp.State = kv["state"]
	resp.Uptime = kv["uptime"]
	resp.UptimeS = parseUptime(kv["uptime"])
	resp.MemoryMB = parseIntPrefix(kv["memory"])
	resp.Goroutine = int(parseIntPrefix(kv["goroutines"]))
	// Connections: "47 in / 55 out"
	if c := kv["connections"]; c != "" {
		parts := strings.SplitN(c, "/", 2)
		if len(parts) == 2 {
			resp.ConnIn = int(parseIntPrefix(parts[0]))
			resp.ConnOut = int(parseIntPrefix(parts[1]))
		}
	}
	// Uplink: "237 B/s (12 MB total)"
	resp.UpRate, resp.UpTotal = splitRateTotal(kv["uplink"])
	resp.DownRate, resp.DownTotal = splitRateTotal(kv["downlink"])

	// 2) version / mode
	resp.Version = firstLine(secs[1])
	resp.Mode = firstLine(secs[2])

	// 3) outbounds：一行「tag<TAB>type<TAB>delay」，统计节点与分组数
	if o := secs[3]; strings.TrimSpace(o) != "" {
		groups, nodes := 0, 0
		sc := bufio.NewScanner(strings.NewReader(o))
		for sc.Scan() {
			f := strings.Split(sc.Text(), "\t")
			if len(f) < 2 {
				continue
			}
			switch f[1] {
			case "selector", "urltest", "balancer":
				groups++
			default:
				nodes++
			}
		}
		resp.Groups, resp.Nodes = groups, nodes
	}
	// 4) group list：一行「分组<TAB>类型<TAB>当前成员」
	if o := secs[4]; strings.TrimSpace(o) != "" {
		sel := make(map[string]string, 24)
		sc := bufio.NewScanner(strings.NewReader(o))
		for sc.Scan() {
			f := strings.Split(sc.Text(), "\t")
			if len(f) < 3 {
				continue
			}
			sel[f[0]] = f[2]
		}
		resp.Selected = sel
	}

	writeJSON(w, 200, resp)
}

// splitSections 按哨兵 ###1..###4 把合并输出切成 5 段（0=status … 4=group list）
func splitSections(out string) [5]string {
	var secs [5]string
	idx := 0
	var b strings.Builder
	flush := func() {
		if idx < 5 {
			secs[idx] = b.String()
		}
		b.Reset()
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "###") && len(line) == 4 {
			flush()
			idx++
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	flush()
	return secs
}

// firstLine 首行去空格（version / mode 都是单行输出）
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// parseIntPrefix 取字符串开头的整数（"94 MB" → 94，"136" → 136）
func parseIntPrefix(s string) int64 {
	s = strings.TrimSpace(s)
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	v, _ := strconv.ParseInt(s[:end], 10, 64)
	return v
}

// splitRateTotal 拆 "237 B/s (12 MB total)" → ("237 B/s", "12 MB")
func splitRateTotal(s string) (rate, total string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ""
	}
	if i := strings.Index(s, "("); i > 0 {
		rate = strings.TrimSpace(s[:i])
		total = strings.TrimSuffix(strings.TrimSpace(s[i+1:]), ")")
		total = strings.TrimSuffix(total, " total")
		return rate, strings.TrimSpace(total)
	}
	return s, ""
}
