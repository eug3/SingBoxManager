import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface ChartSeries {
  points: number[];
  color: string;
}

/** 轻量 SVG 面积图（无第三方图表库，60 点级别足够，浅色主题） */
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
    const all = series.flatMap((s) => s.points);
    const max = Math.max(1, ...all) * 1.12; // 顶部留一点余量，平稳曲线不贴顶
    const n = Math.max(...series.map((s) => s.points.length));
    const step = this.W / Math.max(1, n - 1);
    return series.map((s) => {
      const pts = s.points.map((v, i) => {
        const x = i * step;
        const y = h - (Math.min(v, max) / max) * (h - 3) - 1;
        return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as const;
      });
      const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
      const area = `${line} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h} Z`;
      return { line, area, color: s.color };
    });
  });
}