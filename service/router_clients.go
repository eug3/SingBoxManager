package main

// router_clients.go — 局域网客户端名册：IP → MAC / 主机名
//
// clash_api 的连接元数据只有 sourceIP，没有 MAC。要做「按 MAC 识别电脑」，
// 需要从路由的 DHCP 租约（/tmp/dhcp.leases）与 ARP 表（/proc/net/arp）取 IP→MAC(+hostname)。
// 仅对与路由同二层的 LAN 客户端有效；EasyTier/远端/IPv6 无 MAC 时前端回落到 IP。
//
// GET /router/clients?host=  → {ok, host, clients:[{ip,mac,name}], ms}

import (
	"net/http"
	"strings"
	"time"
)

// parseClients 合并 dhcp.leases 与 /proc/net/arp 输出，产出 IP→{ip,mac,name} 名册。
// 合并口径：
//   - 租约先行：带主机名（hostname 为 * 视为无名），MAC 统一小写；
//   - ARP 补漏：只补 MAC 不带名字，覆盖同 IP 的 mac 字段但保留已有 name；
//   - 全零 MAC（00:00:00:00:00:00，ARP 未完成解析）与空 IP/MAC 一律丢弃。
//
// 纯函数，无副作用；输出顺序不保证（map 遍历），前端自行排序。
func parseClients(leases, arp string) []map[string]string {
	byIP := map[string]map[string]string{}
	// put 归一化后按 IP 归并：mac 总是覆盖，name 只在非空且非 * 时写入
	put := func(ip, mac, name string) {
		ip = strings.TrimSpace(ip)
		mac = strings.ToLower(strings.TrimSpace(mac))
		if ip == "" || mac == "" || mac == "00:00:00:00:00:00" {
			return
		}
		e := byIP[ip]
		if e == nil {
			e = map[string]string{"ip": ip}
			byIP[ip] = e
		}
		e["mac"] = mac
		if name != "" && name != "*" {
			e["name"] = name
		}
	}
	// dhcp.leases: <expiry> <mac> <ip> <hostname> <clientid>（dnsmasq 格式）
	for _, line := range strings.Split(leases, "\n") {
		f := strings.Fields(line)
		if len(f) >= 4 {
			put(f[2], f[1], f[3])
		}
	}
	// /proc/net/arp: IP address / HW type / Flags / HW address / Mask / Device
	// 首行是表头（IP 不含三个点），靠「IPv4 形状」过滤掉
	for _, line := range strings.Split(arp, "\n") {
		f := strings.Fields(line)
		if len(f) >= 4 && strings.Count(f[0], ".") == 3 {
			put(f[0], f[3], "")
		}
	}
	out := make([]map[string]string, 0, len(byIP))
	for _, e := range byIP {
		out = append(out, e)
	}
	return out
}

// handleRouterClients GET /router/clients?host= —— LAN 客户端名册。
// 两份远端文件各自容忍失败（2>/dev/null）：只要有一份读到就出结果；
// 两份都失败才 502。先 pickRouter 再鉴权，口径同其它 /router/* 接口。
func handleRouterClients(w http.ResponseWriter, r *http.Request) {
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
	t0 := time.Now()
	leases, e1 := sshExec(host, cred, "cat /tmp/dhcp.leases 2>/dev/null", nil, 15*time.Second)
	arp, e2 := sshExec(host, cred, "cat /proc/net/arp 2>/dev/null", nil, 15*time.Second)
	if e1 != nil && e2 != nil {
		fail(w, 502, "读取客户端名册失败: "+cleanLine(e1.Error()))
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "host": host, "clients": parseClients(leases, arp),
		"ms": time.Since(t0).Milliseconds(),
	})
}
