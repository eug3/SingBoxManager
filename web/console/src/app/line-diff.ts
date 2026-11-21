/**
 * line-diff.ts — 行级 diff（LCS 动态规划），给「配置」页的暂存变更做预览。
 *
 * 只做展示用途：最多返回 60 行明细，但 adds/dels 统计是全量的；
 * 两侧行数乘积超过 400 万时放弃明细（防超大文件卡 UI），统计也归零。
 */

export interface DiffLine {
  kind: 'add' | 'del';
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  adds: number;
  dels: number;
}

/** lineDiff 比较两段文本，返回增删行明细与计数 */
export function lineDiff(aText: string, bText: string): DiffResult {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return { lines: [], adds: 0, dels: 0 };

  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 沿 dp 回溯：相等跳过；否则优先记删除（与旧版展示顺序一致）
  const lines: DiffLine[] = [];
  let adds = 0;
  let dels = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'del', text: a[i++] });
      dels++;
    } else {
      lines.push({ kind: 'add', text: b[j++] });
      adds++;
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: a[i++] });
    dels++;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j++] });
    adds++;
  }
  return { lines: lines.slice(0, 60), adds, dels };
}