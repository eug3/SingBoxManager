package main

// router_ssh.go — SSH 通道与远端编排（路由上不需要预装任何脚本）。
//
// 背景：sing-box 没有任何 reload/写配置 API（Clash API 的 PUT /configs 是空实现，
// 1.15 的 services{type:"api"} 是 gRPC 运行时观测，同样不能改配置）。
// 所以「改配置 → 生效」= 备份 → sing-box check → 原子替换 → 重启 → 健康检查（失败回滚），
// 全部由本文件在 99 侧编排，通过 SSH 上传候选配置到路由 /tmp 并执行内联脚本完成。
//
// 只用到路由既有命令：/opt/sing-box/sing-box、/etc/init.d/sing-box、netstat、sha256sum、cp/mv。
// 路径可用环境变量覆盖：ROUTER_CONFIG / ROUTER_SINGBOX / ROUTER_INIT。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// 路由侧默认路径（OpenWrt / GL.iNet 官方 sing-box 安装布局）
const (
	defaultRouterConfig = "/etc/sing-box/config.json"
	defaultRouterBin    = "/opt/sing-box/sing-box"
	defaultRouterInit   = "/etc/init.d/sing-box"
)

// routerConfigPath 路由上 config.json 的路径（ROUTER_CONFIG 可覆盖）
func routerConfigPath() string { return env("ROUTER_CONFIG", defaultRouterConfig) }

// routerBin 路由上 sing-box 二进制路径（ROUTER_SINGBOX 可覆盖）
func routerBin() string { return env("ROUTER_SINGBOX", defaultRouterBin) }

// routerInit 路由上 sing-box 的 init 脚本路径（ROUTER_INIT 可覆盖）
func routerInit() string { return env("ROUTER_INIT", defaultRouterInit) }

// ---- SSH 基础 ----

// sshDial 建一条 SSH 会话连接，只对「连不上」做 3 次退避重试（400ms/800ms/1200ms）。
// 重试只覆盖拨号 + 建会话：dropbear 在连续连接时偶发握手失败（防暴雨机制），重试有意义。
// 「Permission denied」属口令错误，立即返回不重试。
func sshDial(host string, cred routerCred) (*ssh.Client, *ssh.Session, error) {
	cfg := &ssh.ClientConfig{
		User:            cred.User,
		Auth:            []ssh.AuthMethod{ssh.Password(cred.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 内网设备，无稳定 host key
		Timeout:         8 * time.Second,
	}
	addr := net.JoinHostPort(host, fmt.Sprint(cred.Port))
	var client *ssh.Client
	var err error
	for attempt := 1; ; attempt++ {
		client, err = ssh.Dial("tcp", addr, cfg)
		if err == nil {
			break
		}
		if strings.Contains(err.Error(), "Permission denied") {
			return nil, nil, fmt.Errorf("ssh 连接 %s 失败: %w", addr, err) // 口令错就别重试
		}
		if attempt >= 3 {
			return nil, nil, fmt.Errorf("ssh 连接 %s 失败（已重试 %d 次）: %w", addr, attempt, err)
		}
		time.Sleep(time.Duration(attempt) * 400 * time.Millisecond)
	}
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("ssh session: %w", err)
	}
	return client, sess, nil
}

// sshExec 执行一条远端命令（stdin 可选），返回合并后的 stdout+stderr 文本。
//
// 重要：命令本身**不重试**。本服务的远端脚本大量用非零退出码表达结果（check 未通过、
// 回滚失败、 unhealthy…），而且很多会删临时文件 / 替换二进制 —— 重跑既拿不到真实输出
// （只剩「no such file」），又可能对非幂等脚本产生副作用。实测 /router/check 对坏 JSON
// 返回的就是第 3 次重跑的「open …: no such file」，真实报错被完全掩盖。
// 所以：连不上 → sshDial 里重试；命令跑了 → 首次输出 + 原样错误直接返回。
func sshExec(host string, cred routerCred, cmd string, stdin []byte, timeout time.Duration) (string, error) {
	return sshExecOnce(host, cred, cmd, stdin, timeout)
}

// sshExecOnce 单次 SSH 会话：拨号 → 建会话 → 跑命令 → 收输出，带整体超时。
// 超时口径：到点向远端发 SIGKILL 并返回「已收到的输出 + 超时错误」；
// 正常结束时 stderr 非空则追加在 stdout 之后（补换行分隔）。
// 命令非零退出返回 *ssh.ExitError（调用方按需取退出码），输出照常带回。
func sshExecOnce(host string, cred routerCred, cmd string, stdin []byte, timeout time.Duration) (string, error) {
	client, sess, err := sshDial(host, cred)
	if err != nil {
		return "", err
	}
	defer client.Close()
	defer sess.Close()

	// 坑：x/crypto/ssh 不允许 Stdout/Stderr 共用同一个 writer（会静默丢输出），
	// 必须双缓冲分开收，最后再手工合并。
	// 用带锁的 writer：超时分支返回时 sess.Run 还在后台 goroutine 里可能继续写，
	// 而 bytes.Buffer 不是并发安全的（-race 会报）。
	var outBuf, errBuf syncBuffer
	sess.Stdout = &outBuf
	sess.Stderr = &errBuf
	if len(stdin) > 0 {
		sess.Stdin = bytes.NewReader(stdin)
	}

	// Run 放 goroutine 里跑，select 挂整体超时；到点发 SIGKILL 尽量收尾
	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = sess.Signal(ssh.SIGKILL)
		// 给后台 goroutine 一点时间把 SIGKILL 后残余的输出写完，再取快照（避免读到一半）
		select {
		case <-done:
		case <-time.After(500 * time.Millisecond):
		}
		return outBuf.combined(&errBuf), fmt.Errorf("超时（%s）", timeout)
	}
	return outBuf.combined(&errBuf), err
}

// syncBuffer 带锁的字节缓冲：stdout / stderr 各一个，供并发的拷贝 goroutine 与主 goroutine 安全读写
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

// String 取当前内容快照
func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// combined 取「stdout 在前、stderr 追加在后」的合并文本；stderr 非空且 stdout 不以换行结尾时补一个换行避免黏行
func (o *syncBuffer) combined(e *syncBuffer) string {
	o.mu.Lock()
	out := o.b.String()
	o.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.b.Len() == 0 {
		return out
	}
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out + e.b.String()
}

// healthSnippet 远端健康检查脚本片段：必须「换了新 pid」且 :9090 在监听。
// 只看端口会被旧进程退出前残留的 socket 骗过（实测踩过），所以两个条件都要。
// sbg_pid 取当前 sing-box run 进程 pid；health(old) 最多等 60 秒（每秒一轮），
// 新 pid ≠ old 且 9090 在监听才算健康。apply/restart 脚本都内嵌这一段。
func healthSnippet() string {
	return `sbg_pid() { ps w 2>/dev/null | grep '[s]ing-box run' | awk '{print $1}' | head -1; }
health() {
  old="$1"; i=0
  while [ "$i" -lt 60 ]; do
    pid=$(sbg_pid)
    if [ -n "$pid" ] && [ "$pid" != "$old" ] && netstat -lnt 2>/dev/null | grep -q ':9090 '; then return 0; fi
    i=$((i+1)); sleep 1
  done
  return 1
}`
}

// ---- 具体动作（全部由 99 编排） ----

// remoteReadConfig 读当前 config.json 原文（保留路由上的缩进与行尾风格）
func remoteReadConfig(host string, cred routerCred) (string, error) {
	return sshExec(host, cred, "cat "+routerConfigPath(), nil, 30*time.Second)
}

// remoteConfigSha 当前配置的 sha256（乐观锁 expectSha 的比对基准）
func remoteConfigSha(host string, cred routerCred) (string, error) {
	out, err := sshExec(host, cred, "sha256sum "+routerConfigPath()+" | cut -d' ' -f1", nil, 20*time.Second)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0]), nil
}

// remoteUpload 把内容写到路由的指定路径（umask 077：临时配置也不给别的用户读）
func remoteUpload(host string, cred routerCred, path string, content []byte) error {
	out, err := sshExec(host, cred, "umask 077; cat > "+path, content, 30*time.Second)
	if err != nil {
		return fmt.Errorf("上传失败: %w %s", err, cleanLine(out))
	}
	return nil
}

// remoteCheckConfig 在路由上校验候选配置（同版本二进制，比在 99 上模拟可靠）。
// 候选先传 /tmp 临时文件，check 完即删。返回 (是否通过, check 输出摘要)。
func remoteCheckConfig(host string, cred routerCred, content string) (bool, string) {
	tmp := fmt.Sprintf("/tmp/vault-check-%d.json", time.Now().UnixNano())
	if err := remoteUpload(host, cred, tmp, []byte(content)); err != nil {
		return false, err.Error()
	}
	out, err := sshExec(host, cred, routerBin()+" check -c "+tmp+"; rc=$?; rm -f "+tmp+"; exit $rc", nil, 90*time.Second)
	return err == nil, strings.TrimSpace(out)
}

// applyResult apply 的结果（changed=false 表示内容没变，跳过了重启）
type applyResult struct {
	Changed bool   `json:"changed"`
	Log     string `json:"log"`
}

// applyScript 构造「应用候选配置」的内联 shell 脚本（经 sh -s 从 stdin 执行）。
// 流程：check → 备份 → 原子替换 → 重启 → 健康检查；不健康自动还原备份再重启。
// 退出码约定：13=check 失败；14=备份失败；15=替换失败；16=不健康（已尝试回滚）；0=成功。
// 输出标记：CHECK_FAILED / BACKUP_FAILED / INSTALL_FAILED / BACKUP=<路径> /
// APPLIED / UNHEALTHY_ROLLBACK / ROLLBACK_OK / ROLLBACK_FAILED。
// 安全口径：tmp/newSha 都是本服务生成的纯 hex/数字串，直接内插安全；
// 候选配置本体走 /tmp 文件，不塞进脚本文本。
func applyScript(tmp, newSha string) string {
	return healthSnippet() + `
set -u
TMP="` + tmp + `"
CFG="` + routerConfigPath() + `"
SB="` + routerBin() + `"
INIT="` + routerInit() + `"
TS=$(date +%Y%m%d-%H%M%S)

if ! OUT=$("$SB" check -c "$TMP" 2>&1); then
  echo "CHECK_FAILED"; echo "$OUT"; rm -f "$TMP"; exit 13
fi
BAK="$CFG.bak-$TS-before-apply"
cp -p "$CFG" "$BAK" || { echo "BACKUP_FAILED"; rm -f "$TMP"; exit 14; }
cp -p "$TMP" "$CFG.tmp" && chmod 644 "$CFG.tmp" && mv "$CFG.tmp" "$CFG" || { echo "INSTALL_FAILED"; rm -f "$TMP"; exit 15; }
rm -f "$TMP"
echo "BACKUP=$BAK"

OLD=$(sbg_pid)
T0=$(date +%s)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then
  echo "APPLIED"
  echo "sha=` + newSha + `"
  echo "downtime_s=$(( $(date +%s) - T0 ))"
  exit 0
fi
echo "UNHEALTHY_ROLLBACK"
cp -p "$BAK" "$CFG"
OLD=$(sbg_pid)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then echo "ROLLBACK_OK"; else echo "ROLLBACK_FAILED"; fi
exit 16
`
}

// remoteApplyConfig 应用候选配置：
//  1. 比对 expectSha（被他人改过 → STALE，HTTP 层转 409）
//  2. 内容相同 → NO_CHANGE，不重启
//  3. 上传候选 → 远端 check → 备份 → 原子替换 → 重启 → 健康检查
//  4. 不健康 → 自动还原备份并重启（ROLLBACK_OK / ROLLBACK_FAILED）
//
// 返回 applyResult（Changed/Log）；失败时 error 文案带标记词
// （STALE / check 未通过 / 已自动回滚），HTTP 层据此映射 409/422/502。
func remoteApplyConfig(host string, cred routerCred, content, expectSha string) (applyResult, error) {
	cur, err := remoteConfigSha(host, cred)
	if err != nil {
		return applyResult{}, fmt.Errorf("读取当前配置失败: %w", err)
	}
	newSum := sha256.Sum256([]byte(content))
	newSha := hex.EncodeToString(newSum[:])
	logLine := fmt.Sprintf("current_sha=%s\ncandidate_sha=%s\n", cur, newSha)

	// 乐观锁：调用方声明的基准摘要与路由现状不一致 → 拒绝写入
	if expectSha != "" && expectSha != cur {
		return applyResult{}, fmt.Errorf("STALE 配置已被他人修改（expected=%s current=%s），请刷新后重试", expectSha, cur)
	}
	if newSha == cur {
		return applyResult{Changed: false, Log: logLine + "NO_CHANGE"}, nil
	}

	tmp := fmt.Sprintf("/tmp/vault-apply-%d.json", time.Now().UnixNano())
	if err := remoteUpload(host, cred, tmp, []byte(content)); err != nil {
		return applyResult{}, err
	}

	out, err := sshExec(host, cred, "sh -s", []byte(applyScript(tmp, newSha)), 180*time.Second)
	full := logLine + out
	// 结果判定按输出标记词优先（脚本退出码只作兜底），顺序不可乱：
	// CHECK_FAILED/ROLLBACK_OK 都属失败，必须先于 APPLIED 判断
	switch {
	case strings.Contains(out, "CHECK_FAILED"):
		return applyResult{}, fmt.Errorf("sing-box check 未通过：%s", cleanLine(out))
	case strings.Contains(out, "ROLLBACK_OK"):
		return applyResult{}, fmt.Errorf("新配置重启后不健康，已自动回滚：%s", cleanLine(out))
	case strings.Contains(out, "APPLIED"):
		return applyResult{Changed: true, Log: full}, nil
	case err != nil:
		return applyResult{}, fmt.Errorf("应用失败：%v %s", err, cleanLine(full))
	default:
		return applyResult{}, fmt.Errorf("应用失败：%s", cleanLine(full))
	}
}

// restartScript 构造「仅重启」的内联 shell 脚本：重启 → 健康检查。
// 输出 RESTARTED + downtime_s；不健康输出 RESTART_UNHEALTHY 并退出 17。
func restartScript() string {
	return healthSnippet() + `
set -u
INIT="` + routerInit() + `"
OLD=$(sbg_pid)
T0=$(date +%s)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then
  echo "RESTARTED"
  echo "downtime_s=$(( $(date +%s) - T0 ))"
  exit 0
fi
echo "RESTART_UNHEALTHY"
exit 17
`
}

// remoteRestart 仅重启 sing-box 并等健康（不改配置）。
// 返回远端输出；未见 RESTARTED 标记或 SSH 出错都返回「重启失败」error。
func remoteRestart(host string, cred routerCred) (string, error) {
	out, err := sshExec(host, cred, "sh -s", []byte(restartScript()), 120*time.Second)
	if err != nil || !strings.Contains(out, "RESTARTED") {
		return out, fmt.Errorf("重启失败: %s", cleanLine(out))
	}
	return out, nil
}

// cleanLine 把多行远端输出压成一行摘要（最多 6 行，" | " 分隔），给日志与错误文案用
func cleanLine(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	lines := strings.Split(strings.TrimSpace(s), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
		if len(out) >= 6 {
			break
		}
	}
	return strings.Join(out, " | ")
}
