import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface ChartSeries {
  points: number[];
  color: string;
}

/** 轻量 SVG 面积图（无第三方图表库，60 点级别足够，浅色主题） */
/** 图宽固定 240，最多画 160 个点，再密就肉眼无收益、还会像素级锯齿 */
const MAX_DRAW_POINTS = 160;

/** 桶平均降采样：把 n 个点压到 ≤max 个点（保留首尾） */
function reduce(points: number[], max: number): number[] {
  if (points.length <= max) return points;
  const bucket = points.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor(i * bucket);
    const to = Math.max(from + 1, Math.floor((i + 1) * bucket));
    let sum = 0;
    for (let j = from; j < to; j++) sum += points[j] ?? 0;
    out.push(sum / (to - from));
  }
  return out;
}

/** 3 点二项平滑（端点保持原值），把毛刺抚平但保留趋势 */
function smooth(points: number[]): number[] {
  if (points.length < 3) return points;
  const out = points.slice();
  for (let i = 1; i < points.length - 1; i++) {
    out[i] = points[i - 1] * 0.25 + points[i] * 0.5 + points[i + 1] * 0.25;
  }
  return out;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** Catmull-Rom 样条 → 三次贝塞尔，曲线平滑且不过冲（端点切线收敛） */
function curve(pts: readonly (readonly [number, number])[]): string {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = round(p1[0] + (p2[0] - p0[0]) / 6);
    const c1y = round(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = round(p2[0] - (p3[0] - p1[0]) / 6);
    const c2y = round(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${c1x} ${c1y},${c2x} ${c2y},${p2[0]} ${p2[1]}`;
  }
  return d;
}

@Component({
  selector: 'app-area-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="chart"
      [attr.viewBox]="'0 0 ' + W + ' ' + height()"
      [attr.height]="height()"
      preserveAspectRatio="none"
    >
      @for (g of grid(); track $index) {
        <line class="gl" [attr.x1]="0" [attr.x2]="W" [attr.y1]="g" [attr.y2]="g" />
      }
      @for (s of paths(); track $index) {
        <path [attr.d]="s.area" [attr.fill]="s.color" fill-opacity="0.14" stroke="none" />
        <path [attr.d]="s.line" fill="none" [attr.stroke]="s.color" stroke-width="1.5" />
      }
      @if (!paths().length) {
        <text x="4" y="14" class="empty">暂无数据</text>
      }
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    .chart {
      width: 100%;
      display: block;
      border: 1px solid var(--line);
      background: #fbfdff;
      box-sizing: border-box;
    }
    .gl {
      stroke: #eef2f8;
      stroke-width: 1;
    }
    .empty {
      fill: #9aa7b6;
      font-size: 10px;
    }
  `,
})
export class AreaChartComponent {
  protected readonly W = 240;

  readonly series = input<ChartSeries[]>([]);
  readonly height = input(64);

  protected readonly grid = computed(() => {
    const h = this.height();
    return [h * 0.25, h * 0.5, h * 0.75].map((v) => Math.round(v * 10) / 10);
  });

  protected readonly paths = computed(() => {
    const series = this.series().filter((s) => s.points.length > 1);
    if (!series.length) return [];
    const h = this.height();
    // 先按桶取平均降采样，再做 3 点二项平滑，避免 1s 采样的锯齿
    const reduced = series.map((s) => reduce(s.points, MAX_DRAW_POINTS));
    const smoothed = reduced.map((pts) => smooth(pts));
    const all = smoothed.flatMap((s) => s);
    const max = Math.max(1, ...all) * 1.12; // 顶部留一点余量，平稳曲线不贴顶
    return smoothed.map((points, idx) => {
      const step = this.W / Math.max(1, points.length - 1);
      const pts = points.map((v, i) => {
        const x = i * step;
        const y = h - (Math.min(v, max) / max) * (h - 3) - 1;
        return [round(x), round(Math.max(1, Math.min(h, y)))] as const;
      });
      const line = curve(pts);
      const area = `${line} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h} Z`;
      return { line, area, color: series[idx].color };
    });
  });
}