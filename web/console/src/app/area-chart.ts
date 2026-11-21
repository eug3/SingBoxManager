import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** 序列点位允许 null：null = 该格还没数据（初始化时空位，靠右对齐、逐格往前推） */
export interface ChartSeries {
  points: (number | null)[];
  color: string;
}

type ChartMode = 'line' | 'bar';

const round = (n: number): number => Math.round(n * 10) / 10;

/** 3 点二项平滑（只在连续有数据的段内做，跨越空档不插值） */
function smoothRun(values: number[]): number[] {
  if (values.length < 3) return values;
  const out = values.slice();
  for (let i = 1; i < values.length - 1; i++) {
    out[i] = values[i - 1] * 0.25 + values[i] * 0.5 + values[i + 1] * 0.25;
  }
  return out;
}

/** Catmull-Rom 样条 → 三次贝塞尔 */
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
 * - 序列长度固定 = 窗口格数（如 10 分钟 = 300 格），空位为 null，数据靠右推进
 * - mode='line'：平滑曲线 + 半透明面积，线宽 1px
 * - mode='bar'：柱形；mirror=true 时以中线为轴（series[0] 向上、series[1] 向下）
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
        <text x="4" y="14" class="empty">等待数据…</text>
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
  /** 双系列镜像（上=series[0]，下=series[1]） */
  readonly mirror = input(false);
  /** 固定满量程（与 series 同单位）；设置后 y 轴不再自适应 */
  readonly fixedMax = input<number | undefined>(undefined);

  protected readonly grid = computed(() => {
    const h = this.height();
    return [h * 0.25, h * 0.5, h * 0.75].map(round);
  });

  /** 所有序列共用的格数（固定长度，空位 null） */
  private readonly slots = computed(() => Math.max(0, ...this.series().map((s) => s.points.length)));

  private readonly scaleMax = computed(() => {
    const fixed = this.fixedMax();
    if (fixed && fixed > 0) return fixed;
    const values = this.series().flatMap((s) => s.points).filter((v): v is number => v !== null);
    return Math.max(1, ...values) * 1.12;
  });

  protected readonly paths = computed(() => {
    const slots = this.slots();
    if (!slots) return [];
    const h = this.height();
    const max = this.scaleMax();
    const step = this.W / Math.max(1, slots - 1);
    const yOf = (v: number): number => round(Math.max(1, Math.min(h, h - (Math.min(v, max) / max) * (h - 3) - 1)));

    return this.series()
      .map((s) => {
        let line = '';
        let area = '';
        let runX: number[] = [];
        let runV: number[] = [];
        const flush = (): void => {
          if (runX.length >= 2) {
            const ys = smoothRun(runV).map(yOf);
            const pts = runX.map((x, i) => [round(x), ys[i]] as const);
            line += curve(pts);
            area += `${curve(pts)} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h} Z`;
          }
          runX = [];
          runV = [];
        };
        s.points.forEach((v, i) => {
          if (v === null) {
            flush();
            return;
          }
          runX.push(i * step);
          runV.push(v);
        });
        flush();
        return { line, area, color: s.color };
      })
      .filter((s) => s.line);
  });

  protected readonly bars = computed(() => {
    const slots = this.slots();
    if (!slots) return [];
    const h = this.height();
    const step = this.W / Math.max(1, slots);
    const w = Math.max(0.5, step * 0.68);
    const center = h / 2;
    const values = this.series().map((s) => s.points.filter((v): v is number => v !== null));
    const fixed = this.fixedMax();
    const flatMax = this.scaleMax();
    const topMax = fixed && fixed > 0 ? fixed : Math.max(1, ...values[0]) * 1.06;
    const bottomMax = fixed && fixed > 0 ? fixed : Math.max(1, ...(values[1] ?? [0])) * 1.06;

    const rect = (x: number, y1: number, y2: number): string => {
      const top0 = round(Math.min(y1, y2));
      const hh = round(Math.abs(y1 - y2));
      return `M${round(x)} ${top0} h${round(w)} v${hh} h${round(-w)} Z`;
    };

    return this.series()
      .map((s, idx) => {
        let path = '';
        s.points.forEach((v, i) => {
          if (v === null) return;
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
      })
      .filter((b) => b.d);
  });
}