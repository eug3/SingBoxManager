package main

// vps.go — 远程 VPS 台账 + sing-box masque server 一键部署（2026-11-29）
//
// 流程：浏览器填主机/凭据 → 99 的 Go 服务 SSH 过去 → 探测 arch/libc →
// 从 99 的版本缓存上传 sing-box 二进制 → 幂等部署脚本（目录/证书/配置/systemd/校验）
// → 回读校验通过后生成 masque-client endpoint，交给前端写进共享节点池。
//
// 设计口径（见 docs/plan-vps-masque.md）：
//   · 参数一律经 shq() 单引号转义后进脚本，密码不落 argv（走 base64/heredoc）；
//   · 已有 config.json 先备份，不改用户手改过的证书；check 失败即停、远端保持原样；
//   · 只报告云安全组/Caddy HTTP/3 之类的占端口问题，**不自动改**防火墙与其他服务配置；
//   · 密码只写不读：GET 列表回 masked。

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---- 默认落点（与 2026-11-15 手工部署口径一致）----

const (
	vpsRemoteBin  = "/opt/sing-box-masque/sing-box"
	vpsRemoteDir  = "/etc/sing-box-masque"
	vpsUnitName   = "sing-box-masque"
	vpsUploadPath = "/tmp/sb-masque.upload"
	vpsMasqueUser = "masque"
)

// vpsRec 一台受管 VPS（SQLite vps 表）
type vpsRec struct {
	Host         string `json:"host"`
	Name         string `json:"name"`
	User         string `json:"user"`
	Password     string `json:"password,omitempty"` // 只写不读
	Port         int    `json:"port"`
	SNI          string `json:"sni"`
	ListenPort   int    `json:"listenPort"`
	AddrPool     string `json:"addrPool"`
	CertMode     string `json:"certMode"` // self | existing
	CertPath     string `json:"certPath"`
	KeyPath      string `json:"keyPath"`
	Version      string `json:"version"` // 期望部署的 sing-box 版本（从 99 缓存选）
	State        string `json:"state"`   // new | deployed | failed
	LastDeployAt string `json:"lastDeployAt"`
	LastError    string `json:"lastError"`
	LastLog      string `json:"lastLog"`
	NodeJSON     string `json:"nodeJson"` // 生成的 masque-client endpoint
	UpdatedAt    string `json:"updatedAt"`
}

// vpsReq POST /vps/save|preview|deploy 的请求体（Password 空 = 沿用库里已存的）
type vpsReq struct {
	Host       string `json:"host"`
	Name       string `json:"name"`
	User       string `json:"user"`
	Password   string `json:"password"`
	Port       int    `json:"port"`
	SNI        string `json:"sni"`
	ListenPort int    `json:"listenPort"`
	AddrPool   string `json:"addrPool"`
	CertMode   string `json:"certMode"`
	CertPath   string `json:"certPath"`
	KeyPath    string `json:"keyPath"`
	Version    string `json:"version"`
}

// vpsDeployPlan 单次部署的全部入参（纯函数的输入，便于单测）
type vpsDeployPlan struct {
	Host           string
	Tag            string // 池内节点 tag
	SNI            string
	ListenPort     int
	AddrPool       string
	MasquePassword string
	CertMode       string
	CertPath       string
	KeyPath        string
	RemoteBin      string
	RemoteDir      string
}

// ---- 纯函数（单测覆盖）----

// shq 把任意字符串安全地塞进单引号上下文：' → '\”，其余原样；空串返回 ”
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

var vpsTagRe = regexp.MustCompile(`[^a-z0-9._-]+`)

// defaultVpsTag 由名称/域名推导合法的小写 tag（与现有 masque-* / skn-* 口径一致）
func defaultVpsTag(name, host string) string {
	base := strings.ToLower(strings.TrimSpace(name))
	if base == "" {
		base = strings.ToLower(strings.TrimSpace(host))
	}
	base = strings.ReplaceAll(base, " ", "-")
	base = vpsTagRe.ReplaceAllString(base, "-")
	base = strings.Trim(base, "-.")
	if base == "" {
		base = "vps"
	}
	if base[0] < 'a' || base[0] > 'z' {
		base = "vps-" + base
	}
	if len(base) > 40 {
		base = base[:40]
	}
	return base
}

var addrPoolRe = regexp.MustCompile(`^172\.20\.(\d{1,3})\.1/24$`)

// nextAddrPool 在已用池里挑下一个 172.20.N.1/24（0..254），全忙则返回空
func nextAddrPool(used []string) string {
	taken := map[int]bool{}
	for _, u := range used {
		if m := addrPoolRe.FindStringSubmatch(strings.TrimSpace(u)); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n >= 0 && n < 255 {
				taken[n] = true
			}
		}
	}
	for n := 0; n < 255; n++ {
		if !taken[n] {
			return fmt.Sprintf("172.20.%d.1/24", n)
		}
	}
	return ""
}

// masqueServerConfigJSON 生成 masque-server 端点的完整 config.json（含 log/endpoints）
func masqueServerConfigJSON(p vpsDeployPlan) (string, error) {
	if p.ListenPort <= 0 || p.ListenPort > 65535 {
		return "", fmt.Errorf("监听端口不合法：%d", p.ListenPort)
	}
	if strings.TrimSpace(p.AddrPool) == "" {
		return "", fmt.Errorf("地址池不能为空")
	}
	if strings.TrimSpace(p.MasquePassword) == "" {
		return "", fmt.Errorf("masque 密码不能为空")
	}
	certPath := p.CertPath
	keyPath := p.KeyPath
	if p.CertMode != "existing" {
		certPath = p.RemoteDir + "/cert.pem"
		keyPath = p.RemoteDir + "/key.pem"
	}
	if strings.TrimSpace(certPath) == "" || strings.TrimSpace(keyPath) == "" {
		return "", fmt.Errorf("证书路径不能为空")
	}
	cfg := map[string]any{
		"log": map[string]any{"level": "warn", "timestamp": true},
		"endpoints": []any{
			map[string]any{
				"type":             "masque-server",
				"tag":              "masque-server",
				"listen":           "::",
				"listen_port":      p.ListenPort,
				"version":          []int{3},
				"users":            []any{map[string]any{"username": vpsMasqueUser, "password": p.MasquePassword}},
				"address":          []string{p.AddrPool},
				"advertise_routes": []string{"0.0.0.0/0", "::/0"},
				"mtu":              1280,
				"tls": map[string]any{
					"enabled":          true,
					"certificate_path": certPath,
					"key_path":         keyPath,
					"server_name":      p.SNI,
				},
			},
		},
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b) + "\n", nil
}

// masqueClientEndpoint 生成路由器侧要用的 masque-client endpoint（写进共享节点池的形状）
func masqueClientEndpoint(tag, server, sni string, port int, password string) map[string]any {
	if strings.TrimSpace(sni) == "" {
		sni = server
	}
	return map[string]any{
		"type":        "masque-client",
		"tag":         tag,
		"server":      server,
		"server_port": port,
		"username":    vpsMasqueUser,
		"password":    password,
		"version":     3,
		"tls": map[string]any{
			"enabled":     true,
			"server_name": sni,
			"insecure":    true, // 自签证书；P3 上 ACME 后可关
		},
		"mtu": 1280,
	}
}

// vpsProbeScript 只读探测：架构 / libc / 权限 / systemd / 端口占用 / 是否已装
func vpsProbeScript(listenPort int) string {
	return `set -u
echo "ARCH=$(uname -m 2>/dev/null)"
if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | head -1 | grep -qi musl; then
  echo "LIBC=musl"
elif ls /lib/ld-musl-* >/dev/null 2>&1; then
  echo "LIBC=musl"
else
  echo "LIBC=glibc"
fi
echo "ROOT=$(id -u 2>/dev/null)"
if command -v systemctl >/dev/null 2>&1; then echo "HAS_SYSTEMD=1"; else echo "HAS_SYSTEMD=0"; fi
if command -v ss >/dev/null 2>&1 && ss -lun 2>/dev/null | awk '{print $5}' | grep -q ':` + strconv.Itoa(listenPort) + `$'; then
  echo "PORT_INUSE=1"
else
  echo "PORT_INUSE=0"
fi
echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown)"
echo "EXISTING=$( [ -f ` + vpsRemoteDir + `/config.json ] && echo 1 || echo 0 )"
echo "EXISTING_VER=$( [ -x ` + vpsRemoteBin + ` ] && ` + vpsRemoteBin + ` version 2>/dev/null | head -1 || echo none )"
echo PROBE_DONE`
}

// vpsDeployScript 幂等部署脚本：装二进制 → 备份 → 证书 → 配置 → check → systemd → 校验
// 所有参数都经 shq() 转义；配置正文走 base64，避免 heredoc 转义问题。
// 输出标记：MISSING_UPLOAD / NO_SYSTEMD / NOT_ROOT / INSTALL_FAILED / VERIFY_FAILED /
// CERT_FAILED / CHECK_FAILED / START_FAILED / NOT_ACTIVE / LISTEN_MISSING / OK_DEPLOYED
func vpsDeployScript(p vpsDeployPlan, cfgJSON string) string {
	b64 := base64.StdEncoding.EncodeToString([]byte(cfgJSON))
	dir, bin := shq(p.RemoteDir), shq(p.RemoteBin)
	selfCert := p.CertMode != "existing"
	return `set -u
BIN=` + bin + `
DIR=` + dir + `
PORT=` + strconv.Itoa(p.ListenPort) + `
[ "$(id -u 2>/dev/null)" = "0" ] || { echo NOT_ROOT; exit 22; }
command -v systemctl >/dev/null 2>&1 || { echo NO_SYSTEMD; exit 21; }
[ -s ` + vpsUploadPath + ` ] || { echo MISSING_UPLOAD; exit 23; }
mkdir -p "$(dirname "$BIN")" "$DIR" || { echo MKDIR_FAILED; exit 24; }
chmod 700 "$DIR" 2>/dev/null || true
# 1) 装二进制：先落 .new 再 mv（运行中的同名文件不可覆盖）
install -m 0755 ` + vpsUploadPath + ` "$BIN.new" || { echo INSTALL_FAILED; exit 25; }
VER=$("$BIN.new" version 2>&1 | head -1) || { rm -f "$BIN.new"; echo VERIFY_FAILED; exit 26; }
mv -f "$BIN.new" "$BIN" || { echo INSTALL_FAILED; exit 25; }
echo "BIN_VERSION=$VER"
# 2) 备份已有配置
if [ -f "$DIR/config.json" ]; then
  cp -a "$DIR/config.json" "$DIR/config.json.bak-$(date +%Y%m%d-%H%M%S)" || true
fi
# 3) 证书：self 缺失才生成（不覆盖已有）；existing 则校验路径存在
` + func() string {
		if selfCert {
			return `if [ ! -s "$DIR/cert.pem" ] || [ ! -s "$DIR/key.pem" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes \
      -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -subj "/CN=` + p.SNI + `" >/dev/null 2>&1 \
      || { echo CERT_FAILED; exit 27; }
  else
    ( cd "$DIR" && "$BIN" generate tls-keypair ` + shq(p.SNI) + ` >/dev/null 2>&1 ) || { echo CERT_FAILED; exit 27; }
    [ -s "$DIR/cert.pem" ] && [ -s "$DIR/key.pem" ] || { echo CERT_FAILED; exit 27; }
  fi
fi
chmod 600 "$DIR/key.pem" 2>/dev/null || true
echo CERT=self`
		}
		return `[ -s ` + shq(p.CertPath) + ` ] || { echo CERT_FAILED; exit 27; }
[ -s ` + shq(p.KeyPath) + ` ] || { echo CERT_FAILED; exit 27; }
echo CERT=existing`
	}() + `
# 4) 写配置（base64 解码，避免任何转义问题）
echo '` + b64 + `' | base64 -d > "$DIR/config.json" || { echo CFG_WRITE_FAILED; exit 28; }
chmod 600 "$DIR/config.json" 2>/dev/null || true
# 5) 校验配置（不过就停：远端仍是旧状态）
"$BIN" check -c "$DIR/config.json" >/tmp/sb-masque-check.log 2>&1 || {
  echo CHECK_FAILED; head -5 /tmp/sb-masque-check.log; exit 29; }
echo CHECK_OK
# 6) systemd unit
cat > /etc/systemd/system/` + vpsUnitName + `.service <<'UNIT'
[Unit]
Description=sing-box MASQUE server (managed by vault-edit)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=` + p.RemoteBin + ` run -c ` + p.RemoteDir + `/config.json
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload || { echo START_FAILED; exit 30; }
systemctl enable --now ` + vpsUnitName + ` >/dev/null 2>&1 || { echo START_FAILED; exit 30; }
# 7) 回读校验
sleep 2
systemctl is-active --quiet ` + vpsUnitName + ` || { echo NOT_ACTIVE; systemctl status ` + vpsUnitName + ` --no-pager -n 5 2>&1 | tail -6; exit 31; }
if command -v ss >/dev/null 2>&1 && ss -lun 2>/dev/null | awk '{print $5}' | grep -q ":$PORT\$"; then
  echo "LISTEN_OK=$PORT/udp"
else
  echo "LISTEN_MISSING=$PORT/udp（可能被云安全组/其他服务占用）"
fi
echo "UPTIME_ACTIVE=$(systemctl show -p ActiveEnterTimestamp --value ` + vpsUnitName + ` 2>/dev/null)"
echo OK_DEPLOYED`
}

// vpsMasquePW 随机 masque 用户密码（16 字节 hex）
func vpsMasquePW() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ---- 存储 ----

const vpsSchemaSQL = `
CREATE TABLE IF NOT EXISTS vps (
  host         TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  user         TEXT NOT NULL DEFAULT 'root',
  password     TEXT NOT NULL DEFAULT '',
  port         INTEGER NOT NULL DEFAULT 22,
  sni          TEXT NOT NULL DEFAULT '',
  listen_port  INTEGER NOT NULL DEFAULT 443,
  addr_pool    TEXT NOT NULL DEFAULT '',
  cert_mode    TEXT NOT NULL DEFAULT 'self',
  cert_path    TEXT NOT NULL DEFAULT '',
  key_path     TEXT NOT NULL DEFAULT '',
  version      TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'new',
  last_deploy_at TEXT NOT NULL DEFAULT '',
  last_error   TEXT NOT NULL DEFAULT '',
  last_log     TEXT NOT NULL DEFAULT '',
  node_json    TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL
);
`

// loadVpsList 读全部 VPS（密码保留在内存里供部署用；对外输出前要 maskVps）
func loadVpsList() ([]vpsRec, error) {
	conn, err := db()
	if err != nil {
		return nil, err
	}
	if _, err := conn.Exec(vpsSchemaSQL); err != nil {
		return nil, err
	}
	rows, err := conn.Query(`SELECT host,name,user,password,port,sni,listen_port,addr_pool,
		cert_mode,cert_path,key_path,version,state,last_deploy_at,last_error,last_log,node_json,updated_at
		FROM vps ORDER BY name, host`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []vpsRec{}
	for rows.Next() {
		var v vpsRec
		if err := rows.Scan(&v.Host, &v.Name, &v.User, &v.Password, &v.Port, &v.SNI, &v.ListenPort,
			&v.AddrPool, &v.CertMode, &v.CertPath, &v.KeyPath, &v.Version, &v.State,
			&v.LastDeployAt, &v.LastError, &v.LastLog, &v.NodeJSON, &v.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// getVps 取一台
func getVps(host string) (vpsRec, bool) {
	list, err := loadVpsList()
	if err != nil {
		return vpsRec{}, false
	}
	for _, v := range list {
		if v.Host == host {
			return v, true
		}
	}
	return vpsRec{}, false
}

// saveVps 新增/更新
func saveVps(v vpsRec) error {
	conn, err := db()
	if err != nil {
		return err
	}
	if _, err := conn.Exec(vpsSchemaSQL); err != nil {
		return err
	}
	if v.UpdatedAt == "" {
		v.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err = conn.Exec(`INSERT INTO vps(host,name,user,password,port,sni,listen_port,addr_pool,cert_mode,
		cert_path,key_path,version,state,last_deploy_at,last_error,last_log,node_json,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(host) DO UPDATE SET name=excluded.name,user=excluded.user,password=excluded.password,
		port=excluded.port,sni=excluded.sni,listen_port=excluded.listen_port,addr_pool=excluded.addr_pool,
		cert_mode=excluded.cert_mode,cert_path=excluded.cert_path,key_path=excluded.key_path,
		version=excluded.version,state=excluded.state,last_deploy_at=excluded.last_deploy_at,
		last_error=excluded.last_error,last_log=excluded.last_log,node_json=excluded.node_json,
		updated_at=excluded.updated_at`,
		v.Host, v.Name, v.User, v.Password, v.Port, v.SNI, v.ListenPort, v.AddrPool, v.CertMode,
		v.CertPath, v.KeyPath, v.Version, v.State, v.LastDeployAt, v.LastError, v.LastLog,
		v.NodeJSON, v.UpdatedAt)
	if err != nil {
		return err
	}
	log.Printf("VPS 台账已保存：%s（%s）", v.Host, v.State)
	return nil
}

// deleteVps 只删台账，不动远端
func deleteVps(host string) error {
	conn, err := db()
	if err != nil {
		return err
	}
	if _, err := conn.Exec(vpsSchemaSQL); err != nil {
		return err
	}
	_, err = conn.Exec(`DELETE FROM vps WHERE host=?`, host)
	return err
}

// maskVps 对外输出：抹掉密码
func maskVps(v vpsRec) vpsRec {
	if v.Password != "" {
		v.Password = "••••••"
	}
	return v
}

// ---- 请求解析 + 校验 ----

// planFromReq 把请求体转成部署计划（复用库里已有的密码/地址池/密码）
func planFromReq(req vpsReq) (vpsDeployPlan, vpsRec, error) {
	host := strings.TrimSpace(req.Host)
	if host == "" {
		return vpsDeployPlan{}, vpsRec{}, fmt.Errorf("host 不能为空")
	}
	old, had := getVps(host)
	rec := old
	rec.Host = host
	rec.Name = strings.TrimSpace(req.Name)
	if rec.Name == "" {
		rec.Name = host
	}
	rec.User = strings.TrimSpace(req.User)
	if rec.User == "" {
		rec.User = "root"
	}
	rec.Password = strings.TrimSpace(req.Password)
	if rec.Password == "" && had {
		rec.Password = old.Password // 空 = 沿用
	}
	if rec.Password == "" {
		return vpsDeployPlan{}, rec, fmt.Errorf("首次添加必须填 SSH 密码")
	}
	rec.Port = req.Port
	if rec.Port <= 0 {
		rec.Port = 22
	}
	rec.SNI = strings.TrimSpace(req.SNI)
	if rec.SNI == "" {
		rec.SNI = host
	}
	rec.ListenPort = req.ListenPort
	if rec.ListenPort <= 0 {
		if had && old.ListenPort > 0 {
			rec.ListenPort = old.ListenPort
		} else {
			rec.ListenPort = 443
		}
	}
	rec.AddrPool = strings.TrimSpace(req.AddrPool)
	if rec.AddrPool == "" && had {
		rec.AddrPool = old.AddrPool
	}
	if rec.AddrPool == "" {
		used := []string{}
		if list, err := loadVpsList(); err == nil {
			for _, v := range list {
				used = append(used, v.AddrPool)
			}
		}
		rec.AddrPool = nextAddrPool(used)
		if rec.AddrPool == "" {
			return vpsDeployPlan{}, rec, fmt.Errorf("172.20.0.0/16 地址池已用尽，请手工指定")
		}
	}
	if !addrPoolRe.MatchString(rec.AddrPool) {
		return vpsDeployPlan{}, rec, fmt.Errorf("地址池格式应为 172.20.N.1/24：%s", rec.AddrPool)
	}
	rec.CertMode = strings.TrimSpace(req.CertMode)
	if rec.CertMode != "existing" {
		rec.CertMode = "self"
	}
	rec.CertPath = strings.TrimSpace(req.CertPath)
	rec.KeyPath = strings.TrimSpace(req.KeyPath)
	if rec.CertMode == "existing" && (rec.CertPath == "" || rec.KeyPath == "") {
		return vpsDeployPlan{}, rec, fmt.Errorf("复用已有证书时必须给出 cert/key 路径")
	}
	rec.Version = strings.TrimSpace(req.Version)
	if rec.Version == "" && had {
		rec.Version = old.Version
	}
	// masque 用户密码：沿用已部署的（从 nodeJson 里取），否则新生成
	maskPW := ""
	if rec.NodeJSON != "" {
		var node map[string]any
		if json.Unmarshal([]byte(rec.NodeJSON), &node) == nil {
			if pw, ok := node["password"].(string); ok {
				maskPW = pw
			}
		}
	}
	if maskPW == "" {
		maskPW = vpsMasquePW()
	}
	tag := defaultVpsTag(rec.Name, host)
	return vpsDeployPlan{
		Host:           host,
		Tag:            tag,
		SNI:            rec.SNI,
		ListenPort:     rec.ListenPort,
		AddrPool:       rec.AddrPool,
		MasquePassword: maskPW,
		CertMode:       rec.CertMode,
		CertPath:       rec.CertPath,
		KeyPath:        rec.KeyPath,
		RemoteBin:      vpsRemoteBin,
		RemoteDir:      vpsRemoteDir,
	}, rec, nil
}
