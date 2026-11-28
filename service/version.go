package main

// version.go — sing-box 版本管理：99 侧下载缓存 → 校验 → 推送部署到受管路由。
//
// 设计口径：
//   · 下载只在 99 上做（99 出网走镜像加速，见 versionMirrors）——路由本身不联网下载；
//   · 缓存按「版本 + 架构」存上游原始 tar.gz（31MB / 版），部署时解包取二进制再推给路由；
//   · 部署是「上传新二进制 → 校验能跑且版本对 → 压缩备份旧二进制 → 原子 rename → 用新二进制 check 配置
//     → 重启 → 健康检查」，任一步失败自动回滚到旧二进制（备份是 gz，省一半磁盘：192 的 overlay 只剩 145MB）；
//   · 只接受官方 release 的版本号与架构白名单，下载 URL 由版本号拼出，不接受任意 URL。
//
// 环境变量：SINGBOX_CACHE（缓存根，默认 /var/lib/vault-edit/singbox）、
// SINGBOX_MIRRORS（镜像前缀，逗号分隔，空项=直连）、SINGBOX_GH_TOKEN（可选，抬高 GitHub API 限额）。

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultVersionCache   = "/var/lib/vault-edit/singbox"
	defaultVersionMirrors = "https://gh-proxy.com/,https://ghfast.top/," // 末项空 = 直连兜底
	ghRepo                = "SagerNet/sing-box"
)

// versionRe 只接受官方版本号形态（1.15.0 / 1.15.0-alpha.15 / 1.15.0-rc.1），
// 用于拼 URL 与目录名，杜绝路径穿越与任意地址下载
var versionRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$`)

// 架构白名单：只放行 sing-box 官方 release 提供的 linux 架构
var versionArches = map[string]bool{
	"amd64": true, "arm64": true, "armv7": true, "386": true,
	"armv6": true, "mipsle": true, "mips": true, "mips64le": true, "riscv64": true,
}

/*
变体：官方 linux 包分三种，选错会「能下载但跑不起来」——实测踩过：

	· ""（默认）：glibc 动态链接，带 libcronet.so，需 /lib/ld-linux-*.so.1；OpenWrt/GL.iNet 没有，直接 not found；
	· "musl"：静态链接（约 83MB），OpenWrt / GL.iNet 用这个；
	· "glibc"：桌面 glibc 系统用。

路由是什么 libc 由 probeRouterVersion 探测，前端按它推荐变体。
*/
var versionVariants = map[string]bool{"": true, "musl": true, "glibc": true}

// variantLabel 给页面显示（空变体=默认包）
func variantLabel(v string) string {
	if v == "" {
		return "default"
	}
	return v
}

// unameArch 把 uname -m 归一到 release 架构名
func unameArch(m string) string {
	switch strings.ToLower(strings.TrimSpace(m)) {
	case "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	case "armv7l", "armv7":
		return "armv7"
	case "armv6l", "armv6":
		return "armv6"
	case "i386", "i686", "x86":
		return "386"
	case "mips64le":
		return "mips64le"
	case "mipsle":
		return "mipsle"
	case "mips":
		return "mips"
	case "riscv64":
		return "riscv64"
	}
	return strings.ToLower(strings.TrimSpace(m))
}

func versionCacheDir() string { return env("SINGBOX_CACHE", defaultVersionCache) }

// versionMirrors 镜像前缀列表；空项代表直连（拼出来的 URL 不加前缀）
func versionMirrors() []string {
	raw := env("SINGBOX_MIRRORS", defaultVersionMirrors)
	out := make([]string, 0, 4)
	for _, p := range strings.Split(raw, ",") {
		out = append(out, strings.TrimSpace(p))
	}
	if len(out) == 0 {
		out = append(out, "")
	}
	return out
}

// versionAssetName 官方 release 里的文件名（variant 为空 = 默认包）
func versionAssetName(version, arch, variant string) string {
	suffix := ""
	if variant != "" {
		suffix = "-" + variant
	}
	return "sing-box-" + version + "-linux-" + arch + suffix + ".tar.gz"
}

// versionDownloadURL 官方下载地址（镜像前缀由调用方加）
func versionDownloadURL(version, arch, variant string) string {
	return "https://github.com/" + ghRepo + "/releases/download/v" + version + "/" + versionAssetName(version, arch, variant)
}

// versionCachePath 缓存文件路径：<根>/<版本>/<上游文件名>
func versionCachePath(version, arch, variant string) string {
	return filepath.Join(versionCacheDir(), version, versionAssetName(version, arch, variant))
}

// versionMetaPath 缓存元信息（sha256 / 来源 / 变体）
func versionMetaPath(version, arch, variant string) string {
	name := arch
	if variant != "" {
		name += "-" + variant
	}
	return filepath.Join(versionCacheDir(), version, name+".meta.json")
}

// allVersionTag 版本号规范成 tag（带 v）
func allVersionTag(version string) string { return "v" + version }

// ---- 缓存清单 ----

// cachedVersion 99 上已缓存的一个「版本 + 架构」
type cachedVersion struct {
	Version string `json:"version"`
	Arch    string `json:"arch"`
	Variant string `json:"variant"`
	Size    int64  `json:"size"`
	Sha256  string `json:"sha256"`
	At      string `json:"at"`
	Source  string `json:"source"`
}

// scanVersionCache 扫缓存目录，按版本倒序返回
func scanVersionCache() []cachedVersion {
	root := versionCacheDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return []cachedVersion{}
	}
	out := make([]cachedVersion, 0, 8)
	for _, e := range entries {
		if !e.IsDir() || !versionRe.MatchString(e.Name()) {
			continue
		}
		version := e.Name()
		files, err := os.ReadDir(filepath.Join(root, version))
		if err != nil {
			continue
		}
		for _, f := range files {
			name := f.Name()
			if !strings.HasSuffix(name, ".tar.gz") {
				continue
			}
			// sing-box-<版本>-linux-<架构>[-变体].tar.gz
			prefix := "sing-box-" + version + "-linux-"
			if !strings.HasPrefix(name, prefix) {
				continue
			}
			rest := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".tar.gz")
			arch, variant := rest, ""
			if i := strings.LastIndex(rest, "-"); i > 0 {
				if tail := rest[i+1:]; tail == "musl" || tail == "glibc" {
					arch, variant = rest[:i], tail
				}
			}
			if arch == "" || !versionArches[arch] {
				continue
			}
			item := cachedVersion{Version: version, Arch: arch, Variant: variant}
			if info, err := f.Info(); err == nil {
				item.Size = info.Size()
				item.At = info.ModTime().UTC().Format(time.RFC3339)
			}
			// meta.json 里存 sha256 与下载来源（可选，缺了也不影响部署）
			if raw, err := os.ReadFile(versionMetaPath(version, arch, variant)); err == nil {
				var m cachedVersion
				if json.Unmarshal(raw, &m) == nil {
					item.Sha256, item.Source = m.Sha256, m.Source
				}
			}
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Version != out[j].Version {
			return out[i].Version > out[j].Version
		}
		return out[i].Arch < out[j].Arch
	})
	return out
}

// ---- 路由侧探测 ----

// routerVersionInfo 一台路由的 sing-box 版本与磁盘现状
type routerVersionInfo struct {
	Host     string `json:"host"`
	Name     string `json:"name"`
	Arch     string `json:"arch"`    // 归一到 release 命名（amd64/arm64…）
	Libc     string `json:"libc"`    // musl / glibc / ""（未知）→ 决定下哪个变体
	Version  string `json:"version"` // 当前运行的 sing-box 版本
	Bin      string `json:"bin"`     // 二进制路径
	BinMB    int64  `json:"binMB"`   // 二进制大小
	FreeMB   int64  `json:"freeMB"`  // 二进制所在分区可用
	Backup   bool   `json:"backup"`  // 是否已有 .prev.gz 备份
	Error    string `json:"error"`   // 探测失败原因
	ProbedAt string `json:"probedAt"`
}

// probeRouterVersion 只读探测：uname、版本、二进制大小、分区可用、有无压缩备份。
// 一次 SSH 跑完，用 MARK 分隔各行，避免多命令输出串行。
func probeRouterVersion(host string, cred routerCred) routerVersionInfo {
	info := routerVersionInfo{Host: host, Name: cred.Name, Bin: routerBin()}
	bin := routerBin()
	cmd := "echo M1; uname -m; echo M2; " + bin + " version 2>&1 | head -1; echo M3; " +
		"ls -l " + bin + " 2>/dev/null | awk '{print $5}'; echo M4; df -k " + bin + " 2>/dev/null | tail -1 | awk '{print $4}'; echo M5; " +
		"ls " + bin + ".prev.gz 2>/dev/null | wc -l; echo M6; " +
		"ls /lib/ld-musl-*.so.1 2>/dev/null | wc -l; echo M7; ls /lib/ld-linux*.so.* 2>/dev/null | wc -l; echo M8"
	out, err := sshExec(host, cred, cmd, nil, 25*time.Second)
	info.ProbedAt = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		info.Error = cleanLine(err.Error() + " " + out)
		return info
	}
	lines := strings.Split(strings.ReplaceAll(out, "\r", ""), "\n")
	// 按 MARK 取值
	val := func(mark string) string {
		for i, l := range lines {
			if strings.TrimSpace(l) == mark && i+1 < len(lines) {
				return strings.TrimSpace(lines[i+1])
			}
		}
		return ""
	}
	info.Arch = unameArch(val("M1"))
	ver := val("M2")
	// 「sing-box version 1.15.0-alpha.13」
	if f := strings.Fields(ver); len(f) >= 3 && f[0] == "sing-box" {
		info.Version = f[len(f)-1]
	} else {
		info.Version = strings.TrimSpace(ver)
	}
	if n := parseInt64(val("M3")); n > 0 {
		info.BinMB = n / (1 << 20)
	}
	if n := parseInt64(val("M4")); n > 0 {
		info.FreeMB = n / 1024
	}
	info.Backup = strings.TrimSpace(val("M5")) != "0"
	// 注意取值对应关系：命令顺序是 …echo M6; <musl 计数>; echo M7; <glibc 计数>; echo M8
	// val(mark) 取的是该标记「下一行」，所以 musl 计数 = val("M6")，glibc 计数 = val("M7")
	switch musl, glibc := strings.TrimSpace(val("M6")), strings.TrimSpace(val("M7")); {
	case musl != "" && musl != "0":
		info.Libc = "musl"
	case glibc != "" && glibc != "0":
		info.Libc = "glibc"
	}
	if info.Version == "" {
		info.Error = "读不到 sing-box 版本（路径可能不是 " + bin + "）"
	}
	return info
}

// parseInt64 宽松解析（远端输出可能是空行）
func parseInt64(s string) int64 {
	var n int64
	for _, c := range strings.TrimSpace(s) {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

// ---- GET /router/versions ----

func handleVersionList(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	all, err := loadRouters()
	hosts := make([]string, 0, len(all))
	for h := range all {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	routers := make([]routerVersionInfo, len(hosts))
	if err == nil {
		var wg sync.WaitGroup
		for i, h := range hosts {
			wg.Add(1)
			go func(i int, h string) {
				defer wg.Done()
				routers[i] = probeRouterVersion(h, all[h])
			}(i, h)
		}
		wg.Wait()
	}
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"cacheDir": versionCacheDir(),
		"disk":     diskOf99(versionCacheDir()),
		"local":    scanVersionCache(),
		"routers":  routers,
		"mirrors":  versionMirrors(),
	})
}

// diskOf99 99 缓存目录所在分区（给页面显示「够不够再下一个」）
func diskOf99(dir string) map[string]any {
	free, total := diskFree(dir)
	return map[string]any{"freeMB": free, "totalMB": total}
}

// diskFree 目录所在分区的可用/总空间（MB）；目录不存在时向上找已存在的父目录
func diskFree(dir string) (freeMB, totalMB int64) {
	var st syscall.Statfs_t
	p := dir
	for {
		if err := syscall.Statfs(p, &st); err == nil {
			bs := int64(st.Bsize)
			return int64(st.Bavail) * bs / (1 << 20), int64(st.Blocks) * bs / (1 << 20)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return 0, 0
		}
		p = parent
	}
}

// ---- GET /router/versions/available ----

// releaseItem 给前端的版本条目。
// 清单来源用 /tags（约 20KB / 1.9s）而不是 /releases（实测 10 条约 670KB、50s 还会被截断）：
// 下载地址由版本号确定，不需要 release 里的 assets 元数据。
type releaseItem struct {
	Version    string `json:"version"` // 去掉 v
	Tag        string `json:"tag"`
	Prerelease bool   `json:"prerelease"`
	Note       string `json:"note"`
}

var (
	releaseMu     sync.Mutex
	releaseCache  []releaseItem
	releaseAt     time.Time
	releaseErr    string
	releaseTTL    = 10 * time.Minute
	releaseClient = &http.Client{Timeout: 45 * time.Second}
)

// fetchReleases 拉官方 tag 列表（10 分钟内存缓存；失败时返回上次成功的结果并附 warning）
func fetchReleases(force bool) ([]releaseItem, string) {
	releaseMu.Lock()
	defer releaseMu.Unlock()
	if !force && len(releaseCache) > 0 && time.Since(releaseAt) < releaseTTL {
		return releaseCache, releaseErr
	}
	req, err := http.NewRequest(http.MethodGet,
		"https://api.github.com/repos/"+ghRepo+"/tags?per_page=100", nil)
	if err != nil {
		return releaseCache, err.Error()
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if tok := os.Getenv("SINGBOX_GH_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := releaseClient.Do(req)
	if err != nil {
		releaseErr = "拉版本列表失败：" + err.Error()
		return releaseCache, releaseErr
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		releaseErr = fmt.Sprintf("GitHub API %d（可能触发限流，可设 SINGBOX_GH_TOKEN 或稍后重试）", resp.StatusCode)
		return releaseCache, releaseErr
	}
	var raw []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		releaseErr = "解析版本列表失败：" + err.Error()
		return releaseCache, releaseErr
	}
	items := make([]releaseItem, 0, len(raw))
	for _, t := range raw {
		version := strings.TrimPrefix(strings.TrimSpace(t.Name), "v")
		if !versionRe.MatchString(version) {
			continue
		}
		items = append(items, releaseItem{
			Version:    version,
			Tag:        "v" + version,
			Prerelease: strings.Contains(version, "-"),
			Note:       versionNote(version),
		})
	}
	sort.Slice(items, func(i, j int) bool { return compareVersion(items[i].Version, items[j].Version) > 0 })
	releaseCache, releaseAt, releaseErr = items, time.Now(), ""
	return releaseCache, ""
}

// versionNote 从版本号里读预发布阶段，给页面显示
func versionNote(v string) string {
	for _, k := range []string{"alpha", "beta", "rc"} {
		if strings.Contains(v, "-"+k) {
			return k
		}
	}
	return "stable"
}

// compareVersion 粗比较版本号（主.次.补 + 预发布序号），只用于列表排序
func compareVersion(a, b string) int {
	na, pa := splitVersion(a)
	nb, pb := splitVersion(b)
	for i := 0; i < 3; i++ {
		if na[i] != nb[i] {
			if na[i] < nb[i] {
				return -1
			}
			return 1
		}
	}
	// 同号：正式版 > rc > beta > alpha
	ra, rb := stageRank(a), stageRank(b)
	if ra != rb {
		if ra < rb {
			return -1
		}
		return 1
	}
	if pa < pb {
		return -1
	}
	if pa > pb {
		return 1
	}
	return 0
}

// splitVersion "1.15.0-alpha.15" → ([1,15,0], 15)
func splitVersion(v string) ([3]int, int) {
	var nums [3]int
	stage := 0
	main := v
	if i := strings.IndexAny(v, "-"); i >= 0 {
		main = v[:i]
		rest := v[i+1:]
		if j := strings.LastIndex(rest, "."); j >= 0 {
			stage = int(parseInt64(rest[j+1:]))
		} else {
			stage = int(parseInt64(rest))
		}
	}
	parts := strings.Split(main, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		nums[i] = int(parseInt64(parts[i]))
	}
	return nums, stage
}

// stageRank 稳定版最高（入参是完整版本号）
func stageRank(v string) int {
	switch {
	case strings.Contains(v, "-alpha"):
		return 0
	case strings.Contains(v, "-beta"):
		return 1
	case strings.Contains(v, "-rc"):
		return 2
	}
	return 3
}

func handleVersionAvailable(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	force := r.URL.Query().Get("refresh") == "1"
	items, warn := fetchReleases(force)
	cached := map[string]bool{}
	for _, c := range scanVersionCache() {
		cached[c.Version+"|"+c.Arch] = true
	}
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"releases": items,
		"cached":   cached,
		"warning":  warn,
	})
}

// ---- POST /router/versions/download ----

// downloadLocks 同一「版本+架构+变体」同时只允许一个下载（否则两个请求会共用同一个暂存文件互相覆盖）
var downloadLocks sync.Map // key → *sync.Mutex

func lockFor(key string) *sync.Mutex {
	m, _ := downloadLocks.LoadOrStore(key, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// downloadTo 依次尝试镜像前缀下载到 dest（一个暂存路径，本函数不 rename），返回命中的来源前缀
func downloadTo(dest, url string) (string, int64, error) {
	var lastErr error
	for _, prefix := range versionMirrors() {
		full := prefix + url
		n, err := fetchToFile(full, dest)
		if err == nil {
			return prefix, n, nil
		}
		lastErr = fmt.Errorf("%s → %w", prefixLabel(prefix), err)
		log.Printf("版本下载失败（%s）：%v", prefixLabel(prefix), err)
	}
	return "", 0, lastErr
}

func prefixLabel(p string) string {
	if p == "" {
		return "直连"
	}
	return p
}

// fetchToFile 流式下载到 dest（调用方应传一个「暂存路径」，校验通过后再由调用方原子改名）。
// 下载中途失败 / 过小 / 断连都会删掉 dest，不会留下半截文件。
func fetchToFile(url, dest string) (int64, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "vault-edit/1.0 (+singbox-manager)")
	resp, err := (&http.Client{Timeout: 20 * time.Minute}).Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if err != nil {
		os.Remove(dest)
		return 0, err
	}
	if closeErr != nil {
		os.Remove(dest)
		return 0, closeErr
	}
	if n < 1<<20 { // 小于 1MB 必然不对（正式包 28–32MB）
		os.Remove(dest)
		return 0, fmt.Errorf("内容过小（%d 字节），可能被拦截或返回了错误页", n)
	}
	return n, nil
}

// handleVersionDownload 下载某个「版本 + 架构」到 99 缓存
func handleVersionDownload(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	var req struct {
		Version string `json:"version"`
		Arch    string `json:"arch"`
		Variant string `json:"variant"`
		Force   bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	req.Version = strings.TrimSpace(strings.TrimPrefix(req.Version, "v"))
	req.Arch = strings.TrimSpace(req.Arch)
	if !versionRe.MatchString(req.Version) {
		fail(w, 400, "版本号不合法（只接受官方形如 1.15.0 / 1.15.0-alpha.15）")
		return
	}
	if !versionArches[req.Arch] {
		fail(w, 400, "不支持的架构："+req.Arch)
		return
	}
	if !versionVariants[req.Variant] {
		fail(w, 400, "不支持的变体："+req.Variant+"（可选 musl / glibc / 留空=默认包）")
		return
	}
	key := req.Version + "|" + req.Arch + "|" + req.Variant
	mu := lockFor(key)
	mu.Lock()
	defer mu.Unlock()

	dest := versionCachePath(req.Version, req.Arch, req.Variant)
	if fi, err := os.Stat(dest); err == nil && fi.Size() > 1<<20 && !req.Force {
		writeJSON(w, 200, map[string]any{"ok": true, "cached": true, "version": req.Version, "arch": req.Arch,
			"variant": req.Variant, "size": fi.Size()})
		return
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(w, 500, "建缓存目录失败："+err.Error())
		return
	}
	// 下载到暂存路径：校验通过之前绝不碰 dest。
	// 原先 fetchToFile 自己先 rename 到 dest 再校验，force 重下一次坏包就把上一份好缓存删了。
	staging := fmt.Sprintf("%s.%d.part", dest, time.Now().UnixNano())
	defer os.Remove(staging)
	t0 := time.Now()
	src, size, err := downloadTo(staging, versionDownloadURL(req.Version, req.Arch, req.Variant))
	if err != nil {
		fail(w, 502, "下载失败（已试过所有镜像）："+err.Error())
		return
	}
	// 校验：能解出 sing-box 二进制才算有效包，同时算 sha256 存档
	sum, err := tarGzBinarySha(staging)
	if err != nil {
		fail(w, 502, "下载内容不是有效的 sing-box 安装包："+err.Error())
		return
	}
	if err := os.Rename(staging, dest); err != nil {
		fail(w, 500, "落盘失败："+err.Error())
		return
	}
	meta := cachedVersion{Version: req.Version, Arch: req.Arch, Variant: req.Variant, Size: size, Sha256: sum,
		At: time.Now().UTC().Format(time.RFC3339), Source: prefixLabel(src)}
	if raw, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(versionMetaPath(req.Version, req.Arch, req.Variant), raw, 0o600)
	}
	log.Printf("版本已下载：%s/%s/%s（%d 字节，来源 %s，%.1fs）", req.Version, req.Arch, variantLabel(req.Variant), size, prefixLabel(src), time.Since(t0).Seconds())
	writeJSON(w, 200, map[string]any{
		"ok": true, "version": req.Version, "arch": req.Arch, "variant": req.Variant,
		"size": size, "sha256": sum, "source": prefixLabel(src),
		"secs": time.Since(t0).Seconds(),
	})
}

// tarGzBinarySha 校验 tar.gz 里确实有 sing-box 二进制，并返回整个包的 sha256
func tarGzBinarySha(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	// 同一遍读两用：一边算摘要，一边解 tar
	tee := io.TeeReader(f, h)
	gz, err := gzip.NewReader(tee)
	if err != nil {
		return "", fmt.Errorf("不是 gzip：%w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	found := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if hdr.Typeflag == tar.TypeReg && strings.HasSuffix(filepath.Base(hdr.Name), "sing-box") {
			found = true
		}
	}
	if !found {
		return "", errors.New("包内没有 sing-box 二进制")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractBinaryFromTarGz 从 tar.gz 取 sing-box 二进制写到 dst（0755）
func extractBinaryFromTarGz(archive, dst string) (int64, error) {
	f, err := os.Open(archive)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		if hdr.Typeflag != tar.TypeReg || filepath.Base(hdr.Name) != "sing-box" {
			continue
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return 0, err
		}
		n, err := io.Copy(out, tr)
		closeErr := out.Close()
		if err != nil {
			return 0, err
		}
		if closeErr != nil {
			return 0, closeErr
		}
		return n, nil
	}
	return 0, errors.New("包内没有 sing-box 二进制")
}

// ---- POST /router/versions/deploy ----

// deployScript 路由侧部署脚本（经 sh -s 从 stdin 执行）。
// 退出码：31 缺新文件；32 chmod 失败；33 新二进制跑不起来；34 版本不符；
// 35 备份失败；36 替换失败；37 新二进制 check 配置失败（已回滚）；38 重启后不健康（已尝试回滚）。
func deployScript(version string) string {
	return healthSnippet() + `
set -u
BIN="` + routerBin() + `"
NEW="$BIN.new"
CFG="` + routerConfigPath() + `"
INIT="` + routerInit() + `"
PREV="$BIN.prev.gz"
CHECK_OUT=$(mktemp /tmp/sb-check.XXXXXX 2>/dev/null || echo /tmp/sb-check.out)

[ -s "$NEW" ] || { echo MISSING_NEW; rm -f "$CHECK_OUT"; exit 31; }
chmod 755 "$NEW" 2>/dev/null || { echo CHMOD_FAILED; rm -f "$NEW" "$CHECK_OUT"; exit 32; }

# 1) 新二进制能跑、且版本对（架构 / libc 不匹配会在这里暴露）
OUT=$("$NEW" version 2>&1) || { echo VERIFY_FAILED; echo "$OUT"; rm -f "$NEW" "$CHECK_OUT"; exit 33; }
case "$OUT" in
  *"` + version + `"*) : ;;
  *) echo VERSION_MISMATCH; echo "$OUT"; rm -f "$NEW" "$CHECK_OUT"; exit 34 ;;
esac

# 2) 用新二进制校验现有配置 —— 放在替换之前做。
#    sing-box check 只认 -c 给的路径，不关心自己叫什么文件名，所以没必要先 mv 再校验。
#    这样「校验不过」时路由上什么都没动，也就不需要回滚（旧写法要先替换、再解压还原，
#    在只剩一百多 MB 的 overlay 上，还原那一步自己就会 ENOSPC，却照样打印 ROLLBACK_DONE）。
if ! "$NEW" check -c "$CFG" >"$CHECK_OUT" 2>&1; then
  echo CONFIG_CHECK_FAILED
  head -5 "$CHECK_OUT" 2>/dev/null
  rm -f "$NEW" "$CHECK_OUT"
  exit 37
fi
rm -f "$CHECK_OUT"

# 3) 压缩备份旧二进制：先写 .tmp 再 mv，避免中途失败毁掉上一份好备份（gz 省一半磁盘）
gzip -c "$BIN" > "$PREV.tmp" 2>/dev/null && mv "$PREV.tmp" "$PREV" || {
  echo BACKUP_FAILED; rm -f "$NEW" "$PREV.tmp"; exit 35
}
echo "BACKUP=$PREV"

# 4) 原子替换（rename 不影响正在运行的进程）
mv "$NEW" "$BIN" 2>/dev/null || { echo INSTALL_FAILED; rm -f "$NEW"; exit 36; }
chmod 755 "$BIN" || { echo CHMOD_FAILED; exit 32; }
echo INSTALLED

# 5) 重启 + 健康检查；不健康则还原备份并重启，按还原结果如实报告
restore() {
  gzip -dc "$PREV" > "$BIN.rb" 2>/dev/null && chmod 755 "$BIN.rb" && mv "$BIN.rb" "$BIN"
}
OLD=$(sbg_pid)
T0=$(date +%s)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then
  echo DEPLOYED
  echo "downtime_s=$(( $(date +%s) - T0 ))"
  exit 0
fi
echo UNHEALTHY_ROLLBACK
if restore; then
  OLD=$(sbg_pid)
  "$INIT" restart >/dev/null 2>&1
  if health "$OLD"; then echo ROLLBACK_OK; else echo ROLLBACK_FAILED; fi
  exit 38
fi
echo ROLLBACK_RESTORE_FAILED
exit 39
`
}

func handleVersionDeploy(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	var req struct {
		Host    string `json:"host"`
		Version string `json:"version"`
		Arch    string `json:"arch"`
		Variant string `json:"variant"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	req.Version = strings.TrimSpace(strings.TrimPrefix(req.Version, "v"))
	req.Arch = strings.TrimSpace(req.Arch)
	if !versionRe.MatchString(req.Version) {
		fail(w, 400, "版本号不合法")
		return
	}
	cred, host, err := pickRouter(req.Host)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	if !versionVariants[req.Variant] {
		fail(w, 400, "不支持的变体："+req.Variant)
		return
	}
	archive := versionCachePath(req.Version, req.Arch, req.Variant)
	if fi, err := os.Stat(archive); err != nil || fi.Size() < 1<<20 {
		fail(w, 400, fmt.Sprintf("%s/%s/%s 还没下载到 99，先在版本库里下载", req.Version, req.Arch, variantLabel(req.Variant)))
		return
	}

	// 架构必须与路由一致（防止把 amd64 推到 arm64 上）
	info := probeRouterVersion(host, cred)
	if info.Error != "" {
		fail(w, 502, "探测路由失败："+info.Error)
		return
	}
	if info.Arch != req.Arch {
		fail(w, 400, fmt.Sprintf("架构不匹配：路由 %s 是 %s，这是 %s 的包", host, info.Arch, req.Arch))
		return
	}
	// libc 预检：musl 路由（OpenWrt / GL.iNet）必须用 musl 静态包，默认包是 glibc 动态链接，推上去只会 not found
	if info.Libc == "musl" && req.Variant != "musl" {
		fail(w, 400, fmt.Sprintf("包变体不匹配：路由 %s 是 musl（OpenWrt/GL.iNet），必须用 musl 静态包；当前选的是 %s", host, variantLabel(req.Variant)))
		return
	}
	if info.Libc == "glibc" && req.Variant == "musl" {
		fail(w, 400, fmt.Sprintf("包变体不匹配：路由 %s 是 glibc 系统，不该用 musl 包", host))
		return
	}

	// 磁盘预检：新二进制 + gz 备份（约 40%）+ 8MB 余量
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("sing-box-%s-%s-%d", req.Version, req.Arch, time.Now().UnixNano()))
	size, err := extractBinaryFromTarGz(archive, tmp)
	if err != nil {
		fail(w, 500, "解包失败："+err.Error())
		return
	}
	defer os.Remove(tmp)
	needMB := size/(1<<20) + size*40/100/(1<<20) + 8
	if info.FreeMB > 0 && info.FreeMB < needMB {
		fail(w, 507, fmt.Sprintf("路由磁盘不够：%s 只剩 %d MB，部署约需 %d MB（新二进制 %d MB + 压缩备份）", host, info.FreeMB, needMB, size/(1<<20)))
		return
	}

	t0 := time.Now()
	bin := routerBin()
	// 上传到 <bin>.new（同一分区，后面 rename 才是原子的；也避免 /tmp 是 tmpfs 时白白占内存）
	data, err := os.ReadFile(tmp)
	if err != nil {
		fail(w, 500, "读临时文件失败："+err.Error())
		return
	}
	if out, err := sshExecOnce(host, cred, "umask 022; cat > "+bin+".new", data, 15*time.Minute); err != nil {
		_, _ = sshExecOnce(host, cred, "rm -f "+bin+".new", nil, 15*time.Second) // 别把几十 MB 留在紧张的路由盘上
		fail(w, 502, "上传新二进制失败："+cleanLine(err.Error()+" "+out))
		return
	}
	uploadSecs := time.Since(t0).Seconds()
	// 回读校验：远端大小必须与本地一致（SSH 上传静默截断过一次，不能只信退出码）
	if chk, err := sshExecOnce(host, cred, "ls -l "+bin+".new 2>&1; echo RC=$?", nil, 20*time.Second); err != nil || !uploadBytesMatch(chk, size) {
		log.Printf("上传校验失败 %s：want=%d 远端=%q err=%v", host, size, truncOut(chk, 300), err)
		_, _ = sshExecOnce(host, cred, "rm -f "+bin+".new", nil, 15*time.Second)
		fail(w, 502, fmt.Sprintf("上传后校验失败（本地 %d 字节）：%s", size, cleanLine(chk+" "+fmt.Sprint(err))))
		return
	}

	// 脚本先落到路由 /tmp 再执行（而不是 sh -s 走 stdin）：便于失败后 cat 出来排查，
	// 也避免「stdin 脚本 + 大文件传输」在某些 dropbear 上互相干扰
	scriptPath := fmt.Sprintf("/tmp/vault-deploy-%d.sh", time.Now().UnixNano())
	if upOut, upErr := sshExecOnce(host, cred, "umask 077; cat > "+scriptPath, []byte(deployScript(req.Version)), 30*time.Second); upErr != nil {
		fail(w, 502, "上传部署脚本失败："+cleanLine(upErr.Error()+" "+upOut))
		return
	}
	out, scriptErr := sshExec(host, cred, "sh "+scriptPath+"; rc=$?; echo SCRIPT_RC=$rc; exit $rc", nil, 240*time.Second)
	if strings.Contains(out, "SCRIPT_RC=0") {
		_, _ = sshExec(host, cred, "rm -f "+scriptPath, nil, 10*time.Second)
	}
	// 失败时脚本留在路由 /tmp（脚本内容由本服务按已知入参生成，不必再开一条会话抓回来）
	log.Printf("版本部署 %s %s/%s/%s：scriptErr=%v out=%q", host, req.Version, req.Arch, variantLabel(req.Variant), scriptErr, truncOut(out, 2000))
	after := probeRouterVersion(host, cred)
	resp := map[string]any{
		"ok": false, "host": host, "version": req.Version, "arch": req.Arch,
		"sizeMB": size / (1 << 20), "uploadSecs": uploadSecs,
		"secs": time.Since(t0).Seconds(), "log": strings.TrimSpace(truncOut(out, 4000)),
		"before": info.Version, "after": after.Version, "backup": after.Backup,
		"freeMB": after.FreeMB,
	}
	switch {
	// 结果判定按「最危险的状态优先」排列，避免标记词互相包含时被前面的分支抢走。
	// 最危险的是「回滚还原本身失败」：此时磁盘上是校验不过的新二进制，进程还在跑但下次重启起不来。
	case strings.Contains(out, "ROLLBACK_RESTORE_FAILED"):
		resp["error"] = "部署失败，且还原旧二进制也失败（磁盘上是校验不过配置的新二进制，进程暂在运行，但下次重启会起不来）。请立即登录路由处理：" + cleanLine(out)
		failJSON(w, 500, resp)
		return
	case strings.Contains(out, "ROLLBACK_OK"):
		resp["error"] = "部署失败（新二进制重启后不健康），已自动回滚到旧二进制并重启：" + cleanLine(out)
		failJSON(w, 502, resp)
		return
	case strings.Contains(out, "ROLLBACK_FAILED"):
		resp["error"] = "部署失败且回滚后仍不健康，请立即登录路由处理：" + cleanLine(out)
		failJSON(w, 500, resp)
		return
	case strings.Contains(out, "VERSION_MISMATCH"), strings.Contains(out, "VERIFY_FAILED"),
		strings.Contains(out, "CONFIG_CHECK_FAILED"), strings.Contains(out, "BACKUP_FAILED"),
		strings.Contains(out, "CHMOD_FAILED"), strings.Contains(out, "INSTALL_FAILED"),
		strings.Contains(out, "MISSING_NEW"), scriptErr != nil:
		resp["error"] = "部署失败：" + cleanLine(out) + errSuffix(scriptErr)
		failJSON(w, 502, resp)
		return
	case !strings.Contains(out, "DEPLOYED"):
		resp["error"] = "部署未确认成功：" + cleanLine(out) + errSuffix(scriptErr)
		failJSON(w, 502, resp)
		return
	}
	resp["ok"] = true
	log.Printf("版本部署成功：%s %s → %s（上传 %.1fs，总 %.1fs）", host, info.Version, req.Version, uploadSecs, time.Since(t0).Seconds())
	writeJSON(w, 200, resp)
}

// uploadBytesMatch 判断远端 ls -l 输出里的字节数是否等于本地大小
func uploadBytesMatch(lsOut string, want int64) bool {
	for _, line := range strings.Split(lsOut, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || !strings.HasPrefix(f[0], "-") {
			continue
		}
		if parseInt64(f[4]) == want {
			return true
		}
	}
	return false
}

// errSuffix 把 SSH 层错误附在文案后面（脚本自己没输出时，原因常在 err 里）
func errSuffix(err error) string {
	if err == nil {
		return ""
	}
	return "（" + err.Error() + "）"
}

// truncOut 日志用：截断过长输出
func truncOut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// failJSON 失败时也要把结构化结果带给前端（否则前端拿不到「已回滚」这些细节）
func failJSON(w http.ResponseWriter, code int, v map[string]any) {
	writeJSON(w, code, v)
}

// ---- POST /router/versions/remove ----

func handleVersionRemove(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	var req struct {
		Version string `json:"version"`
		Arch    string `json:"arch"`
		Variant string `json:"variant"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	if !versionRe.MatchString(req.Version) || !versionArches[req.Arch] || !versionVariants[req.Variant] {
		fail(w, 400, "版本号 / 架构 / 变体不合法")
		return
	}
	removed := []string{}
	for _, p := range []string{versionCachePath(req.Version, req.Arch, req.Variant), versionMetaPath(req.Version, req.Arch, req.Variant)} {
		if err := os.Remove(p); err == nil {
			removed = append(removed, filepath.Base(p))
		}
	}
	// 目录空了就删掉
	_ = os.Remove(filepath.Join(versionCacheDir(), req.Version))
	if len(removed) == 0 {
		fail(w, 404, "缓存里没有这个版本")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "removed": removed})
}

// runtimeArch 99 自己的架构（前端提示「本机是 amd64」用，纯信息）
func runtimeArch() string { return runtime.GOARCH }
