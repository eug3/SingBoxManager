package main

// vps_http.go — /vps/* 接口：台账增删、dry-run 预览、探测、一键部署
//
// 鉴权沿用 /router/* 口径：X-Vault-Key（= VAULT_KEY）或登录会话。
// 部署编排：探测 → 选 99 缓存里的包 → 上传 → 跑脚本 → 回读校验 → 生成 client endpoint。

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// vpsCred 把台账记录转成 SSH 凭据（host 单独传）
func vpsCred(v vpsRec) routerCred {
	return routerCred{Name: v.Name, User: v.User, Password: v.Password, Port: v.Port}
}

// vpsAuth 鉴权：与 /router/* 一致（带正确 X-Vault-Key，或已登录会话）
func vpsAuth(w http.ResponseWriter, r *http.Request) bool {
	if hasVaultKeyHeader(r) || hasSession(r) {
		return true
	}
	fail(w, 401, "未登录或密钥不正确")
	return false
}

// handleVpsList GET /vps/list
func handleVpsList(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	list, err := loadVpsList()
	if err != nil {
		fail(w, 500, "读 VPS 台账失败："+err.Error())
		return
	}
	items := make([]vpsRec, 0, len(list))
	used := []string{}
	for _, v := range list {
		items = append(items, maskVps(v))
		used = append(used, v.AddrPool)
	}
	// 99 缓存里可用的 sing-box 包（部署时按 VPS 的 arch/libc 从中选）
	cache := scanVersionCache()
	pkgs := make([]map[string]any, 0, len(cache))
	for _, c := range cache {
		pkgs = append(pkgs, map[string]any{
			"version": c.Version, "arch": c.Arch, "variant": c.Variant,
			"size": c.Size, "at": c.At,
		})
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "items": items, "cache": pkgs,
		"nextAddrPool": nextAddrPool(used),
	})
}

// handleVpsSave POST /vps/save —— 只落台账，不连远端
func handleVpsSave(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	var req vpsReq
	if !readJSON(w, r, &req) {
		return
	}
	_, rec, err := planFromReq(req)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if rec.State == "" {
		rec.State = "new"
	}
	// 保存时不改「已部署」状态与既有 nodeJson（重装要显式 deploy）
	if old, ok := getVps(rec.Host); ok {
		if rec.State == "" || rec.State == "new" {
			rec.State = old.State
		}
		rec.NodeJSON = old.NodeJSON
		rec.LastDeployAt = old.LastDeployAt
		rec.LastError = old.LastError
		rec.LastLog = old.LastLog
	}
	rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := saveVps(rec); err != nil {
		fail(w, 500, "保存失败："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "item": maskVps(rec)})
}

// handleVpsDelete DELETE /vps?host= —— 只删台账，不动远端
func handleVpsDelete(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	if host == "" {
		fail(w, 400, "缺少 host")
		return
	}
	if err := deleteVps(host); err != nil {
		fail(w, 500, "删除失败："+err.Error())
		return
	}
	log.Printf("VPS 台账已删除：%s（远端未卸载）", host)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleVpsPreview POST /vps/preview —— dry-run：回将执行的脚本与配置，不连 VPS
func handleVpsPreview(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	var req vpsReq
	if !readJSON(w, r, &req) {
		return
	}
	plan, rec, err := planFromReq(req)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	cfg, err := masqueServerConfigJSON(plan)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "host": rec.Host, "tag": plan.Tag,
		"config": cfg, "script": vpsDeployScript(plan, cfg),
		"probe": vpsProbeScript(plan.ListenPort),
		"note":  "预览不连远端；确认无误后再点「部署」",
	})
}

// vpsProbe 探测一台 VPS 的部署前置条件
type vpsProbe struct {
	Arch        string `json:"arch"`
	Libc        string `json:"libc"`
	Root        bool   `json:"root"`
	HasSystemd  bool   `json:"hasSystemd"`
	PortInUse   bool   `json:"portInUse"`
	OS          string `json:"os"`
	Existing    bool   `json:"existing"`
	ExistingVer string `json:"existingVer"`
	Raw         string `json:"raw,omitempty"`
}

// runVpsProbe 连上去跑只读探测
func runVpsProbe(rec vpsRec, listenPort int) (vpsProbe, error) {
	out, err := sshExec(rec.Host, vpsCred(rec), vpsProbeScript(listenPort), nil, 30*time.Second)
	p := vpsProbe{Raw: cleanLine(out)}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(cleanANSI(line))
		switch {
		case strings.HasPrefix(line, "ARCH="):
			p.Arch = strings.TrimPrefix(line, "ARCH=")
		case strings.HasPrefix(line, "LIBC="):
			p.Libc = strings.TrimPrefix(line, "LIBC=")
		case strings.HasPrefix(line, "ROOT="):
			p.Root = strings.TrimPrefix(line, "ROOT=") == "0"
		case strings.HasPrefix(line, "HAS_SYSTEMD="):
			p.HasSystemd = strings.TrimPrefix(line, "HAS_SYSTEMD=") == "1"
		case strings.HasPrefix(line, "PORT_INUSE="):
			p.PortInUse = strings.TrimPrefix(line, "PORT_INUSE=") == "1"
		case strings.HasPrefix(line, "OS="):
			p.OS = strings.TrimPrefix(line, "OS=")
		case strings.HasPrefix(line, "EXISTING="):
			p.Existing = strings.TrimPrefix(line, "EXISTING=") == "1"
		case strings.HasPrefix(line, "EXISTING_VER="):
			p.ExistingVer = strings.TrimPrefix(line, "EXISTING_VER=")
		}
	}
	if p.Arch == "" {
		if err != nil {
			return p, fmt.Errorf("探测失败：%v", err)
		}
		return p, fmt.Errorf("探测失败（拿不到架构）：%s", p.Raw)
	}
	return p, nil
}

// handleVpsProbe POST /vps/probe —— 只连不装
func handleVpsProbe(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	var req vpsReq
	if !readJSON(w, r, &req) {
		return
	}
	_, rec, err := planFromReq(req)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	p, perr := runVpsProbe(rec, rec.ListenPort)
	if perr != nil {
		fail(w, 502, perr.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "probe": p})
}

// pickCachedBinary 从 99 缓存里挑一个匹配 arch/libc 的包（prefer 指定的 version）
func pickCachedBinary(arch, libc, wantVersion string) (cachedVersion, bool) {
	arch = unameArch(arch)
	variant := ""
	if libc == "musl" {
		variant = "musl"
	}
	var cands []cachedVersion
	for _, c := range scanVersionCache() {
		if unameArch(c.Arch) != arch {
			continue
		}
		switch variant {
		case "musl":
			if c.Variant == "musl" {
				cands = append(cands, c)
			}
		default:
			// glibc 优先默认包，实在没有再用 glibc 变体（官方默认就是 glibc 动态链接）
			if c.Variant == "" || c.Variant == "glibc" {
				cands = append(cands, c)
			}
		}
	}
	if wantVersion != "" {
		for _, c := range cands {
			if c.Version == wantVersion {
				return c, true
			}
		}
	}
	if len(cands) == 0 {
		return cachedVersion{}, false
	}
	sort.Slice(cands, func(i, j int) bool { return compareVersion(cands[i].Version, cands[j].Version) > 0 })
	return cands[0], true
}

// handleVpsDeploy POST /vps/deploy —— 真部署
func handleVpsDeploy(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !vpsAuth(w, r) {
		return
	}
	var req vpsReq
	if !readJSON(w, r, &req) {
		return
	}
	plan, rec, err := planFromReq(req)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	t0 := time.Now()
	resp := map[string]any{"ok": false, "host": rec.Host, "tag": plan.Tag}

	// ① 探测
	probe, err := runVpsProbe(rec, plan.ListenPort)
	if err != nil {
		rec.State, rec.LastError = "failed", err.Error()
		rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		_ = saveVps(rec)
		resp["error"] = "探测失败：" + err.Error()
		resp["probe"] = probe
		failJSON(w, 502, resp)
		return
	}
	resp["probe"] = probe
	if !probe.HasSystemd {
		resp["error"] = "目标没有 systemd，本功能只支持 systemd 的 Linux（Debian/Ubuntu 等）"
		failJSON(w, 400, resp)
		return
	}
	if !probe.Root {
		resp["error"] = "SSH 用户不是 root，部署需要 root 权限"
		failJSON(w, 400, resp)
		return
	}
	if probe.PortInUse {
		resp["error"] = fmt.Sprintf("UDP %d 已被占用（可能是 Caddy HTTP/3 或另一个 masque），换个端口或先腾出", plan.ListenPort)
		failJSON(w, 409, resp)
		return
	}

	// ② 选包（99 缓存）→ 解出二进制
	pkg, ok := pickCachedBinary(probe.Arch, probe.Libc, rec.Version)
	if !ok {
		resp["error"] = fmt.Sprintf("99 缓存里没有匹配 %s/%s 的 sing-box 包，先去「版本管理」下载",
			unameArch(probe.Arch), libcLabel(probe.Libc))
		failJSON(w, 400, resp)
		return
	}
	rec.Version = pkg.Version
	archive := versionCachePath(pkg.Version, pkg.Arch, pkg.Variant)
	tmp, err := os.MkdirTemp("", "vps-bin-")
	if err != nil {
		fail(w, 500, "建临时目录失败："+err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	binPath := filepath.Join(tmp, "sing-box")
	size, err := extractBinaryFromTarGz(archive, binPath)
	if err != nil {
		resp["error"] = "解包失败：" + err.Error()
		failJSON(w, 500, resp)
		return
	}
	data, err := os.ReadFile(binPath)
	if err != nil {
		fail(w, 500, "读临时文件失败："+err.Error())
		return
	}
	resp["binary"] = map[string]any{
		"version": pkg.Version, "arch": pkg.Arch, "variant": pkg.Variant,
		"sizeMB": size / (1 << 20),
	}

	// ③ 上传（到 /tmp，装完脚本自己清理）
	if upOut, upErr := sshExecOnce(rec.Host, vpsCred(rec),
		"umask 077; cat > "+vpsUploadPath, data, 10*time.Minute); upErr != nil {
		resp["error"] = "上传二进制失败：" + cleanLine(upErr.Error()+" "+upOut)
		failJSON(w, 502, resp)
		return
	}

	// ④ 生成配置 + 脚本并执行
	cfg, err := masqueServerConfigJSON(plan)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	script := vpsDeployScript(plan, cfg)
	out, scriptErr := sshExec(rec.Host, vpsCred(rec), script+`; rc=$?; rm -f `+vpsUploadPath+`; exit $rc`, nil, 5*time.Minute)
	resp["log"] = strings.TrimSpace(truncOut(cleanANSI(out), 4000))
	resp["secs"] = time.Since(t0).Seconds()

	if !strings.Contains(out, "OK_DEPLOYED") {
		rec.State, rec.LastError = "failed", cleanLine(out)
		rec.LastLog = resp["log"].(string)
		rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		_ = saveVps(rec)
		resp["error"] = deployFailReason(out) + errSuffix(scriptErr)
		failJSON(w, 502, resp)
		return
	}

	// ⑤ 成功：生成 client endpoint（写进共享节点池的形状）并落台账
	srv := rec.Host
	if strings.TrimSpace(rec.SNI) != "" {
		srv = rec.SNI // 有域名就用域名（SNI 同名，证书才对得上）
	}
	node := masqueClientEndpoint(plan.Tag, srv, rec.SNI, plan.ListenPort, plan.MasquePassword)
	nodeJSON, _ := json.Marshal(node)
	rec.State = "deployed"
	rec.LastError = ""
	rec.LastDeployAt = time.Now().UTC().Format(time.RFC3339)
	rec.LastLog = resp["log"].(string)
	rec.NodeJSON = string(nodeJSON)
	rec.UpdatedAt = rec.LastDeployAt
	if err := saveVps(rec); err != nil {
		log.Printf("警告：部署成功但台账保存失败：%v", err)
	}
	resp["ok"] = true
	resp["node"] = node
	resp["version"] = pkg.Version
	log.Printf("VPS masque 部署成功：%s（%s/%s，节点 %s，%.1fs）",
		rec.Host, pkg.Version, pkg.Variant, plan.Tag, resp["secs"].(float64))
	writeJSON(w, 200, resp)
}

// deployFailReason 把远端标记翻成人话
func deployFailReason(out string) string {
	switch {
	case strings.Contains(out, "MISSING_UPLOAD"):
		return "上传的二进制不见了（可能 /tmp 不可写或被清理）"
	case strings.Contains(out, "NOT_ROOT"):
		return "SSH 不是 root"
	case strings.Contains(out, "NO_SYSTEMD"):
		return "目标没有 systemd"
	case strings.Contains(out, "INSTALL_FAILED"):
		return "安装二进制失败（磁盘满？权限？）"
	case strings.Contains(out, "VERIFY_FAILED"):
		return "新二进制跑不起来（架构/libc 不匹配）"
	case strings.Contains(out, "CERT_FAILED"):
		return "生成/校验证书失败"
	case strings.Contains(out, "CHECK_FAILED"):
		return "sing-box check 未通过（配置被拒，远端保持原样）"
	case strings.Contains(out, "CFG_WRITE_FAILED"):
		return "写 config.json 失败"
	case strings.Contains(out, "START_FAILED"):
		return "systemd 启动失败"
	case strings.Contains(out, "NOT_ACTIVE"):
		return "服务启动后不是 active 状态"
	default:
		return "部署失败"
	}
}

// libcLabel 给页面显示
func libcLabel(v string) string {
	if v == "" {
		return "未知 libc"
	}
	return v
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// cleanANSI 去掉终端颜色/控制序列（sing-box / systemctl 输出常带）
func cleanANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }
