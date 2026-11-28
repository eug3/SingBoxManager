package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 库文件与 SQLite 边车（-wal / -shm）都必须是 0600，目录 0700。
// 线上实测过：目录 0755 + 只 chmod 主库 → sbm.db-wal 是 0644，本机任何用户可读到最后写入的口令。
func TestDbFilesArePrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "vault-edit")
	path := filepath.Join(dir, "sbm.db")
	t.Setenv("DB_FILE", path)

	// 故意用宽松 umask 起步，模拟线上（边车默认会跟着变 0644）
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(path, []byte(""), 0o644)

	conn, err := db()
	if err != nil {
		t.Fatalf("打开库失败：%v", err)
	}
	if _, err := conn.Exec(`INSERT OR REPLACE INTO kv(key, value, updated_at) VALUES('perm_probe','{"pass":"x"}','now')`); err != nil {
		t.Fatalf("写入失败（边车此时才会被建出来）：%v", err)
	}

	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Errorf("目录权限应为 0700，实际 %o", di.Mode().Perm())
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Errorf("应存在：%s（%v）", p, err)
			continue
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s 权限应为 0600，实际 %o", p, fi.Mode().Perm())
		}
	}
}
