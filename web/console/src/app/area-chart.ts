import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface ChartSeries {
  points: number[];
  color: string;
}

type ChartMode = 'line' | 'bar';

/** 概览已按 2 秒一格聚合（10 分钟 = 300 格），这里只做兜底上限 */
const MAX_LINE_POINTS = 320;
/** 柱形模式柱宽要有下限，太多列会糊成一片 */
const MAX_BAR_POINTS = 160;

const round = (n: number): number => Math.round(n * 10) / 10;

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

/** Catmull-Rom 样条 → 三次贝塞尔，曲线平滑且端点切线收敛 */
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

/**
 * 轻量 SVG 图表（无第三方库）
 * - mode='line'：平滑曲线 + 半透明面积（线宽 1px）
 * - mode='bar'：柱形；mirror=true 时以中线为轴，series[0] 向上、series[1] 向下（上下行速率图）
 */
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
      @if (mirror()) {
        <line class="mid" [attr.x1]="0" [attr.x2]="W" [attr.y1]="height() / 2" [attr.y2]="height() / 2" />
      }
      @for (g of grid(); track $index) {
        <line class="gl" [attr.x1]="0" [attr.x2]="W" [attr.y1]="g" [attr.y2]="g" />
      }

      @if (mode() === 'bar') {
        @for (b of bars(); track $index) {
          <path [attr.d]="b.d" [attr.fill]="b.color" fill-opacity="0.62" />
        }
      } @else {
        @for (s of paths(); track $index) {
          <path [attr.d]="s.area" [attr.fill]="s.color" fill-opacity="0.12" stroke="none" />
          <path [attr.d]="s.line" fill="none" [attr.stroke]="s.color" stroke-width="1" />
        }
      }

      @if ((mode() === 'bar' ? bars().length : paths().length) === 0) {
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
    .mid {
      stroke: #d7e0ec;
      stroke-width: 1;
      stroke-dasharray: 3 3;
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
  readonly mode = input<ChartMode>('line');
  /** 双系列镜像（上=series[0]，下=series[1]），柱形模式用于上下行速率 */
  readonly mirror = input(false);

  protected readonly grid = computed(() => {
    const h = this.height();
    return [h * 0.25, h * 0.5, h * 0.75].map(round);
  });

  private readonly prepared = computed(() => {
    const max = this.mode() === 'bar' ? MAX_BAR_POINTS : MAX_LINE_POINTS;
    return this.series()
      .filter((s) => s.points.length > 1)
      .map((s) => ({ color: s.color, points: smooth(reduce(s.points, max)) }));
  });

  protected readonly paths = computed(() => {
    const series = this.prepared();
    if (!series.length) return [];
    const h = this.height();
    const max = Math.max(1, ...series.flatMap((s) => s.points)) * 1.12; // 顶部留余量
    const n = Math.max(...series.map((s) => s.points.length));
    const step = this.W / Math.max(1, n - 1);
    return series.map((s) => {
      const pts = s.points.map((v, i) => {
        const x = i * step;
        const y = h - (Math.min(v, max) / max) * (h - 3) - 1;
        return [round(x), round(Math.max(1, Math.min(h, y)))] as const;
      });
      const line = curve(pts);
      const area = `${line} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h} Z`;
      return { line, area, color: s.color };
    });
  });

  protected readonly bars = computed(() => {
    const series = this.prepared();
    if (!series.length) return [];
    const h = this.height();
    const n = Math.max(...series.map((s) => s.points.length));
    const step = this.W / Math.max(1, n);
    const w = Math.max(0.7, step * 0.68);
    const center = h / 2;
    const top = series[0];
    const bottom = series[1];
    const topMax = Math.max(1, ...top.points) * 1.06;
    const bottomMax = Math.max(1, ...(bottom?.points ?? [0])) * 1.06;
    const flatMax = Math.max(1, ...series.flatMap((s) => s.points)) * 1.06;

    const rect = (x: number, y1: number, y2: number): string => {
      const top0 = round(Math.min(y1, y2));
      const hh = round(Math.abs(y1 - y2));
      return `M${round(x)} ${top0} h${round(w)} v${hh} h${round(-w)} Z`;
    };

    return series.map((s, idx) => {
      let path = '';
      s.points.forEach((v, i) => {
        const x = i * step + (step - w) / 2;
        if (this.mirror()) {
          const isUp = idx === 0;
          const scale = isUp ? topMax : bottomMax;
          const len = (Math.min(v, scale) / scale) * (center - 2);
          path += isUp ? rect(x, center - len, center) : rect(x, center, center + len);
        } else {
          const y = h - (Math.min(v, flatMax) / flatMax) * (h - 2) - 1;
          path += rect(x, y, h);
        }
      });
      return { d: path, color: s.color };
    });
  });
}