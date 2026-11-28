package main

// sharecfg.go — 规则桶存储的**运行时可改配置**（不再硬编码）。
//
// 落盘：SQLite kv 表（key=shareConfig，见 db.go）。旧的 /etc/vault-edit/share.json
// 只在首次启动且库为空时一次性迁移导入。库里没有记录时用环境变量/默认值兜底，
// 所以旧部署（只有 SMB_ADDR 等 env）照常工作。
//
// 三种后端：
//   smb   纯 Go SMB2 客户端直连 NAS（默认）
//   sftp  纯 Go SFTP（NAS 只开 SSH 时用）
//   local 文件就在本机（99）目录里，完全不依赖 SMB/SFTP —— 此时公网访问要靠
//         反代/内网路径把 /rule-set 指到本服务，PUBLIC_BASE 也要相应改成对外地址。
//
// 接口：
//   GET  /share/config   读当前配置（口令不回显，只回 configured 标记）
//   POST /share/config   保存并立即生效（热替换 ShareFS）
//   POST /share/probe    用「候选配置」试连，不落盘（页面上的「测试」按钮）
//   POST /share/import   把当前共享里的桶文件复制到本机 local 目录（切 local 前用）

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ShareConfig 是存储配置的完整形态（页面齿轮里编辑的就是它）
type ShareConfig struct {
	Mode       string      `json:"mode"` // 后端模式：smb | sftp | local
	SMB        SMBConfig   `json:"smb"`
	SFTP       SFTPConfig  `json:"sftp"`
	Local      LocalConfig `json:"local"`
	PublicBase string      `json:"publicBase"` // 公网只读入口，如 https://rules.example.com
	// FilesListen 只读文件服务的独立监听端口（管理台不跟着暴露），空=不启用
	FilesListen string `json:"filesListen"`
	Sample      string `json:"sample"` // 体检用的样本文档
}

// SMBConfig SMB2 后端参数（addr=host:445；user/pass 留空即 guest）
type SMBConfig struct {
	Addr   string `json:"addr"`
	Share  string `json:"share"`
	Path   string `json:"path"`
	User   string `json:"user"`
	Pass   string `json:"pass"`
	Domain string `json:"domain"`
}

// SFTPConfig SFTP 后端参数（pass 与 key 至少配一个；path 是 NAS 上的绝对目录）
type SFTPConfig struct {
	Addr string `json:"addr"`
	User string `json:"user"`
	Pass string `json:"pass"`
	Key  string `json:"key"`
	Path string `json:"path"`
}

// LocalConfig 本机目录后端参数（SHARE_MODE=local 时用）
type LocalConfig struct {
	Dir string `json:"dir"`
}

var (
	shareCfgMu sync.RWMutex
	shareCfg   ShareConfig
	shareFSMu  sync.RWMutex
	shareFS    ShareFS
)

// shareConfigFile 旧配置文件路径（可用 SHARE_CONFIG 覆盖）；现在只作首次迁移的导入源
func shareConfigFile() string {
	return env("SHARE_CONFIG", "/etc/vault-edit/share.json")
}

// defaultShareConfig 用环境变量+默认值构造初始配置（兼容只有 env 的旧部署）
func defaultShareConfig() ShareConfig {
	return ShareConfig{
		Mode: strings.ToLower(env("SHARE_MODE", "smb")),
		SMB: SMBConfig{
			Addr:   env("SMB_ADDR", "192.168.31.8:445"),
			Share:  env("SMB_SHARE", "HddShare"),
			Path:   env("SMB_PATH", "WebEdit/rule-set"),
			User:   os.Getenv("SMB_USER"),
			Pass:   os.Getenv("SMB_PASS"),
			Domain: os.Getenv("SMB_DOMAIN"),
		},
		SFTP: SFTPConfig{
			Addr: env("SFTP_ADDR", ""),
			User: os.Getenv("SFTP_USER"),
			Pass: os.Getenv("SFTP_PASS"),
			Key:  os.Getenv("SFTP_KEY"),
			Path: env("SFTP_PATH", "/volume1/WebEdit/rule-set"),
		},
		Local: LocalConfig{
			Dir: env("SHARE_LOCAL_DIR", "/usr/local/share/vault-edit/rule-set"),
		},
		PublicBase:  normalizePublicBase(env("PUBLIC_BASE", "https://router.guaishoudejia.com/rule-set/")),
		FilesListen: defaultFilesListen(),
		Sample:      env("HEALTH_SAMPLE", "rs-tg.srs"),
	}
}

// normalizeShareConfig 补默认值、清尾部斜杠，避免页面漏填导致行为异常
func normalizeShareConfig(c ShareConfig) ShareConfig {
	d := defaultShareConfig()
	if c.Mode == "" {
		c.Mode = d.Mode
	}
	c.Mode = strings.ToLower(c.Mode)
	if c.SMB.Addr == "" {
		c.SMB.Addr = d.SMB.Addr
	}
	if c.SMB.Share == "" {
		c.SMB.Share = d.SMB.Share
	}
	if c.SMB.Path == "" {
		c.SMB.Path = d.SMB.Path
	}
	if c.SFTP.Path == "" {
		c.SFTP.Path = d.SFTP.Path
	}
	if c.Local.Dir == "" {
		c.Local.Dir = d.Local.Dir
	}
	c.PublicBase = normalizePublicBase(c.PublicBase)
	if c.FilesListen == "" {
		c.FilesListen = d.FilesListen
	}
	if c.Sample == "" {
		c.Sample = d.Sample
	}
	return c
}

// shareFSFromConfig 按配置构造具体后端（不落盘，可用来「测试」）
func shareFSFromConfig(c ShareConfig) ShareFS {
	c = normalizeShareConfig(c)
	switch c.Mode {
	case "local":
		return &localShare{dir: c.Local.Dir}
	case "sftp":
		return &sftpShare{addr: c.SFTP.Addr, user: c.SFTP.User, pass: c.SFTP.Pass, keyPath: c.SFTP.Key, dir: c.SFTP.Path}
	default:
		return &smbShare{
			addr: c.SMB.Addr, share: c.SMB.Share, subdir: strings.Trim(c.SMB.Path, "/"),
			user: c.SMB.User, pass: c.SMB.Pass, domain: c.SMB.Domain,
		}
	}
}

// loadShareConfig 启动时从 SQLite 读；没有记录则用 env 默认值
func loadShareConfig() ShareConfig {
	raw, ok := kvGet("shareConfig")
	if !ok {
		return defaultShareConfig()
	}
	var c ShareConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return defaultShareConfig()
	}
	return normalizeShareConfig(c)
}

// saveShareConfig 写 SQLite（kv 表，key=shareConfig）
func saveShareConfig(c ShareConfig) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return kvSet("shareConfig", string(b))
}

// currentShareCfg / currentShareFS 线程安全读取
func currentShareCfg() ShareConfig {
	shareCfgMu.RLock()
	defer shareCfgMu.RUnlock()
	return shareCfg
}

func currentShareFS() ShareFS {
	shareFSMu.RLock()
	defer shareFSMu.RUnlock()
	return shareFS
}

// applyShareConfig 热替换后端（保存/启动时调用）：
// 先规整并记录配置，再按新配置构造 ShareFS 原子替换全局引用。
// 旧后端都是惰性连接，丢引用即可，无需显式关闭。
func applyShareConfig(c ShareConfig) {
	shareCfgMu.Lock()
	shareCfg = normalizeShareConfig(c)
	cfg := shareCfg
	shareCfgMu.Unlock()

	fs := shareFSFromConfig(cfg)
	shareFSMu.Lock()
	shareFS = fs
	shareFSMu.Unlock()
}

// keepStoredPasswords 口令留空 → 沿用旧值（页面不回显口令，也不该覆盖）。
// 保存配置与候选试连共用这一口径。
func keepStoredPasswords(c, old ShareConfig) ShareConfig {
	if c.SMB.Pass == "" {
		c.SMB.Pass = old.SMB.Pass
	}
	if c.SFTP.Pass == "" {
		c.SFTP.Pass = old.SFTP.Pass
	}
	return c
}

// publicMasked 返回可回显的配置（口令只给「是否已设置」）
func publicMasked(c ShareConfig) map[string]any {
	return map[string]any{
		"mode": c.Mode,
		"smb": map[string]any{
			"addr": c.SMB.Addr, "share": c.SMB.Share, "path": c.SMB.Path, "user": c.SMB.User,
			"domain": c.SMB.Domain, "passSet": c.SMB.Pass != "",
		},
		"sftp": map[string]any{
			"addr": c.SFTP.Addr, "user": c.SFTP.User, "path": c.SFTP.Path,
			"key": c.SFTP.Key, "passSet": c.SFTP.Pass != "",
		},
		"local":       map[string]any{"dir": c.Local.Dir},
		"publicBase":  normalizePublicBase(c.PublicBase),
		"filesListen": c.FilesListen,
		"sample":      c.Sample,
		"file":        dbFile(),
	}
}

// ---- HTTP ----

// handleShareConfigGet GET /share/config —— 读当前生效配置（口令已掩码）
func handleShareConfigGet(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	// 只读且口令已掩码（只回 passSet），与 /share/health 同级开放，避免顶栏/齿轮 401
	writeJSON(w, 200, map[string]any{"ok": true, "config": publicMasked(currentShareCfg())})
}

// handleShareConfigSet POST /share/config —— 保存并立即生效；口令字段留空表示「保持原值」。
// 成功后附带按新配置探测的文件通道结果（fileOK/files 或 fileError），页面可直接刷新状态点。
func handleShareConfigSet(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	var req struct {
		Config ShareConfig `json:"config"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	old := currentShareCfg()
	c := keepStoredPasswords(normalizeShareConfig(req.Config), old)
	if err := saveShareConfig(c); err != nil {
		fail(w, 500, "写配置失败: "+err.Error())
		return
	}
	applyShareConfig(c)
	// 文件服务独立端口：配置变了就热重启监听（失败只报错，不影响主服务）
	if lerr := filesSrv.apply(c.FilesListen); lerr != nil {
		log.Printf("文件服务应用失败：%v", lerr)
	}
	// 立刻按新配置探一次，把结果一起返回，页面可直接刷新状态点
	files, ferr := currentShareFS().List()
	resp := map[string]any{"ok": true, "saved": true, "config": publicMasked(currentShareCfg()), "mode": c.Mode}
	if ferr != nil {
		resp["fileOK"] = false
		resp["fileError"] = ferr.Error()
	} else {
		resp["fileOK"] = true
		resp["files"] = len(files)
	}
	writeJSON(w, 200, resp)
}

// handleShareProbe POST /share/probe —— 用候选配置试连，不落盘（页面「测试」按钮）。
// 返回与 /share/health 同构的体检结果，另带 mode 字段。
func handleShareProbe(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	var req struct {
		Config ShareConfig `json:"config"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	old := currentShareCfg()
	c := keepStoredPasswords(normalizeShareConfig(req.Config), old)
	fs := shareFSFromConfig(c)
	resp := probeShare(fs, c.PublicBase, c.Sample)
	resp["mode"] = c.Mode
	writeJSON(w, 200, resp)
}

// handleShareImport POST /share/import —— 把当前共享里的桶文件复制到本机 local 目录
// （切 local 前先跑一次）。只复制命中 rsFileRe 的文件，目录与其它文件计入 skipped；
// 任一文件读写失败立即 502/500 返回（不做半程回滚，已复制的保留）。
func handleShareImport(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	src := currentShareFS()
	cfg := currentShareCfg()
	dir := cfg.Local.Dir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(w, 500, "建目录失败: "+err.Error())
		return
	}
	ents, err := src.List()
	if err != nil {
		fail(w, 502, "读源共享失败: "+err.Error())
		return
	}
	copied, skipped := 0, 0
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !rsFileRe.MatchString(name) {
			skipped++
			continue
		}
		data, _, rerr := src.ReadFile(name)
		if rerr != nil {
			fail(w, 502, "读 "+name+" 失败: "+rerr.Error())
			return
		}
		if werr := os.WriteFile(filepath.Join(dir, name), data, 0o644); werr != nil {
			fail(w, 500, "写 "+name+" 失败: "+werr.Error())
			return
		}
		copied++
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "copied": copied, "skipped": skipped, "dir": dir,
		"hint": "复制完成；把存储模式切到 local 即可只依赖 99 本机文件",
	})
}
