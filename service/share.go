package main

// share.go — 规则桶存储抽象：**纯 Go SMB2 客户端**（默认）或本地目录。
//
// 目的：不再依赖管理机上用内核 cifs 把 NAS 挂到 /mnt/hdd。
// NAS 侧共享（HddShare）是 sec=none/guest，所以零凭据即可读写；若以后改成需要账号，
// 用 SMB_USER / SMB_PASS / SMB_DOMAIN 注入即可（值只从环境变量来，不落源码）。
//
// 环境变量：
//   SHARE_MODE   smb | local（默认 smb）
//   SMB_ADDR     NAS 地址，默认 192.168.31.8:445
//   SMB_SHARE    共享名，默认 HddShare
//   SMB_PATH     共享内子目录，默认 WebEdit/rule-set
//   SMB_USER / SMB_PASS / SMB_DOMAIN   可选（默认 guest）
//   SHARE_DIR    local 模式下的目录（兼容旧的挂载用法）
//
// 连接复用：进程内保持一个 SMB session，出错时丢弃重建一次（NAS 重启/网络抖动自愈）。

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/cloudsoda/go-smb2"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ShareFS 是规则桶存储需要的最小文件接口（路径均相对共享内子目录）
type ShareFS interface {
	ReadFile(name string) (data []byte, info os.FileInfo, err error)
	WriteFile(name string, data []byte) error
	Stat(name string) (os.FileInfo, error)
	List() ([]os.FileInfo, error)
	Remove(name string) error
	Describe() string
}

// ---- 本地目录实现（SHARE_MODE=local，等价于旧的 cifs 挂载用法）----

type localShare struct{ dir string }

func (l *localShare) path(name string) string { return path.Join(l.dir, name) }

func (l *localShare) ReadFile(name string) ([]byte, os.FileInfo, error) {
	b, err := os.ReadFile(l.path(name))
	if err != nil {
		return nil, nil, err
	}
	st, err := os.Stat(l.path(name))
	return b, st, err
}

func (l *localShare) WriteFile(name string, data []byte) error {
	return os.WriteFile(l.path(name), data, 0o644)
}

func (l *localShare) Stat(name string) (os.FileInfo, error) { return os.Stat(l.path(name)) }

func (l *localShare) List() ([]os.FileInfo, error) {
	ents, err := os.ReadDir(l.dir)
	if err != nil {
		return nil, err
	}
	out := make([]os.FileInfo, 0, len(ents))
	for _, e := range ents {
		if info, err := e.Info(); err == nil {
			out = append(out, info)
		}
	}
	return out, nil
}

func (l *localShare) Remove(name string) error { return os.Remove(l.path(name)) }

func (l *localShare) Describe() string { return "local:" + l.dir }

// ---- SMB2 实现（纯 Go，无 cifs 挂载）----

type smbShare struct {
	addr, share, subdir, user, pass, domain string

	mu   sync.Mutex
	sess *smb2.Session
	fs   *smb2.Share
}

func (s *smbShare) Describe() string {
	return fmt.Sprintf("smb://%s/%s/%s (user=%s)", s.addr, s.share, s.subdir, orGuest(s.user))
}

func orGuest(u string) string {
	if u == "" {
		return "guest"
	}
	return u
}

// rel 把桶文件名拼成共享内路径（清掉可能的 ../，防止写到子目录外）
func (s *smbShare) rel(name string) string {
	clean := strings.ReplaceAll(name, "\\", "/")
	clean = strings.TrimPrefix(path.Clean("/"+clean), "/")
	if s.subdir == "" {
		return clean
	}
	return s.subdir + "/" + clean
}

// ensure 惰性建链：首次调用或上次失败后重建 session
func (s *smbShare) ensure(ctx context.Context) (*smb2.Share, error) {
	if s.fs != nil {
		return s.fs, nil
	}
	d := &smb2.Dialer{Initiator: &smb2.NTLMInitiator{User: s.user, Password: s.pass, Domain: s.domain}}
	sess, err := d.Dial(ctx, s.addr)
	if err != nil {
		return nil, fmt.Errorf("SMB 连接 %s 失败: %w", s.addr, err)
	}
	fs, err := sess.Mount(s.share)
	if err != nil {
		_ = sess.Logoff()
		return nil, fmt.Errorf("挂载共享 %s 失败: %w", s.share, err)
	}
	s.sess, s.fs = sess, fs
	return fs, nil
}

// drop 丢弃当前连接（下次调用自动重连）
func (s *smbShare) drop() {
	if s.fs != nil {
		_ = s.fs.Umount()
	}
	if s.sess != nil {
		_ = s.sess.Logoff()
	}
	s.fs, s.sess = nil, nil
}

// with 执行一次操作；失败时重连重试一次（NAS 重启/会话超时自愈）
func (s *smbShare) with(fn func(fs *smb2.Share) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		fs, err := s.ensure(ctx)
		cancel()
		if err != nil {
			lastErr = err
			s.drop()
			continue
		}
		if err := fn(fs); err != nil {
			lastErr = err
			s.drop() // 会话可能已失效，下次重连
			continue
		}
		return nil
	}
	return lastErr
}

func (s *smbShare) ReadFile(name string) ([]byte, os.FileInfo, error) {
	var data []byte
	var info os.FileInfo
	err := s.with(func(fs *smb2.Share) error {
		p := s.rel(name)
		b, err := fs.ReadFile(p)
		if err != nil {
			return err
		}
		st, err := fs.Stat(p)
		if err != nil {
			return err
		}
		data, info = b, st
		return nil
	})
	return data, info, err
}

// WriteFile 先写临时名再 rename，避免路由在写到一半时拉走半截文件
func (s *smbShare) WriteFile(name string, data []byte) error {
	return s.with(func(fs *smb2.Share) error {
		p := s.rel(name)
		tmp := p + ".tmp-sbm"
		if err := fs.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := fs.Rename(tmp, p); err != nil {
			_ = fs.Remove(tmp)
			return err
		}
		return nil
	})
}

func (s *smbShare) Remove(name string) error {
	return s.with(func(fs *smb2.Share) error { return fs.Remove(s.rel(name)) })
}

func (s *smbShare) Stat(name string) (os.FileInfo, error) {
	var info os.FileInfo
	err := s.with(func(fs *smb2.Share) error {
		st, err := fs.Stat(s.rel(name))
		if err != nil {
			return err
		}
		info = st
		return nil
	})
	return info, err
}

func (s *smbShare) List() ([]os.FileInfo, error) {
	var out []os.FileInfo
	err := s.with(func(fs *smb2.Share) error {
		ents, err := fs.ReadDir(s.subdir)
		if err != nil {
			return err
		}
		out = ents
		return nil
	})
	return out, err
}

// ---- SFTP 实现（SHARE_MODE=sftp；纯 Go：x/crypto/ssh + pkg/sftp）----
//
// 用途：当 NAS 没开 SMB、但开了 SSH 时，用 SFTP 直接读写同一批桶文件。
// 需要的环境变量：SFTP_ADDR(host:22) SFTP_USER SFTP_PASS(或 SFTP_KEY 私钥路径)
//   SFTP_PATH（共享内子目录，默认 /volume1/WebEdit/rule-set 这类绝对路径）

type sftpShare struct {
	addr, user, pass, keyPath, dir string

	mu     sync.Mutex
	ssh    *ssh.Client
	client *sftp.Client
}

func (s *sftpShare) Describe() string {
	return fmt.Sprintf("sftp://%s%s (user=%s)", s.addr, s.dir, orGuest(s.user))
}

func (s *sftpShare) ensure() (*sftp.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	var auth []ssh.AuthMethod
	if s.keyPath != "" {
		raw, err := os.ReadFile(s.keyPath)
		if err != nil {
			return nil, fmt.Errorf("读私钥失败: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(raw)
		if err != nil {
			return nil, fmt.Errorf("解析私钥失败: %w", err)
		}
		auth = append(auth, ssh.PublicKeys(signer))
	}
	if s.pass != "" {
		auth = append(auth, ssh.Password(s.pass))
	}
	if len(auth) == 0 {
		return nil, fmt.Errorf("SFTP 未配置凭据（需要 SFTP_USER + SFTP_PASS 或 SFTP_KEY）")
	}
	cfg := &ssh.ClientConfig{User: s.user, Auth: auth, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second}
	conn, err := ssh.Dial("tcp", s.addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("SFTP 连接 %s 失败: %w", s.addr, err)
	}
	cli, err := sftp.NewClient(conn)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("SFTP 握手失败: %w", err)
	}
	s.ssh, s.client = conn, cli
	return cli, nil
}

func (s *sftpShare) drop() {
	if s.client != nil {
		_ = s.client.Close()
	}
	if s.ssh != nil {
		_ = s.ssh.Close()
	}
	s.client, s.ssh = nil, nil
}

func (s *sftpShare) rel(name string) string { return path.Join(s.dir, name) }

func (s *sftpShare) with(fn func(c *sftp.Client) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		cli, err := s.ensure()
		if err != nil {
			lastErr = err
			s.drop()
			continue
		}
		if err := fn(cli); err != nil {
			lastErr = err
			s.drop()
			continue
		}
		return nil
	}
	return lastErr
}

func (s *sftpShare) ReadFile(name string) ([]byte, os.FileInfo, error) {
	var data []byte
	var info os.FileInfo
	err := s.with(func(c *sftp.Client) error {
		p := s.rel(name)
		f, err := c.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return err
		}
		b, err := io.ReadAll(f)
		if err != nil {
			return err
		}
		data, info = b, st
		return nil
	})
	return data, info, err
}

func (s *sftpShare) WriteFile(name string, data []byte) error {
	return s.with(func(c *sftp.Client) error {
		p := s.rel(name)
		tmp := p + ".tmp-sbm"
		f, err := c.Create(tmp)
		if err != nil {
			return err
		}
		if _, err := f.Write(data); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		_ = c.Remove(p)
		return c.Rename(tmp, p)
	})
}

func (s *sftpShare) Remove(name string) error {
	return s.with(func(c *sftp.Client) error { return c.Remove(s.rel(name)) })
}

func (s *sftpShare) Stat(name string) (os.FileInfo, error) {
	var info os.FileInfo
	err := s.with(func(c *sftp.Client) error {
		st, err := c.Stat(s.rel(name))
		if err != nil {
			return err
		}
		info = st
		return nil
	})
	return info, err
}

func (s *sftpShare) List() ([]os.FileInfo, error) {
	var out []os.FileInfo
	err := s.with(func(c *sftp.Client) error {
		ents, err := c.ReadDir(s.dir)
		if err != nil {
			return err
		}
		out = ents
		return nil
	})
	return out, err
}
