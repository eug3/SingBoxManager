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

// parseClients 合并 dhcp.leases 与 /proc/net/arp 输出
func parseClients(leases, arp string) []map[string]string {
	byIP := map[string]map[string]string{}
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
	// dhcp.leases: <expiry> <mac> <ip> <hostname> <clientid>
	for _, line := range strings.Split(leases, "\n") {
		f := strings.Fields(line)
		if len(f) >= 4 {
			put(f[2], f[1], f[3])
		}
	}
	// /proc/net/arp: IP address / HW type / Flags / HW address / Mask / Device
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
