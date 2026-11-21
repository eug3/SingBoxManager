import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    require?: any;
    monaco?: any;
  }
}

/** 全局只加载一次 Monaco（多个编辑器实例共享同一个 loader Promise） */
let loading: Promise<any> | null = null;

/** 从本站 /static/monaco/vs 异步加载 Monaco（AMD loader，离线可用，不依赖 CDN） */
function loadMonaco(): Promise<any> {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/static/monaco/vs/loader.js';
    script.onload = () => {
      const req = window.require;
      if (!req) return reject(new Error('Monaco loader 未提供 require'));
      req.config({ paths: { vs: '/static/monaco/vs' } });
      req(['vs/editor/editor.main'], () => {
        const monaco = window.monaco;
        if (!monaco) return reject(new Error('Monaco 初始化失败'));
        monaco.languages.json?.jsonDefaults?.setDiagnosticsOptions?.({ validate: true, allowComments: false });
        resolve(monaco);
      });
    };
    script.onerror = () => reject(new Error('Monaco loader.js 加载失败（/static/monaco/vs 未部署？）'));
    document.head.appendChild(script);
  });
  return loading;
}

@Component({
  selector: 'app-monaco-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="monaco-host" #host></div>`,
  styles: `
    :host { display: block; }
    .monaco-host { width: 100%; height: 420px; border: 1px solid var(--line); }
  `,
})
/**
 * Monaco 编辑器封装 — [value] 进 /(valueChange) 出 的受控组件。
 * 资源来自本站 /static/monaco/vs（AMD loader，离线可用）；外部 setValue 与
 * 用户输入通过 lastEmitted 去重，避免「输出→回填→再输出」回环。
 */
export class MonacoEditorComponent implements OnDestroy {
  readonly value = input<string>('');
  readonly valueChange = output<string>();
  readonly ready = signal(false);
  readonly error = signal<string>('');

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private editor: any = null;
  private lastEmitted: string | null = null;

  constructor() {
    afterNextRender(() => void this.init());
    // 外部改 value（拉取/格式化）时同步进编辑器；忽略自己刚发出的变更，避免回环
    effect(() => {
      const v = this.value();
      if (!this.editor) return;
      if (v === this.lastEmitted) return;
      if (v !== this.editor.getValue()) this.editor.setValue(v ?? '');
    });
  }

  private async init(): Promise<void> {
    try {
      const monaco = await loadMonaco();
      const el = this.host().nativeElement;
      this.editor = monaco.editor.create(el, {
        value: this.value(),
        language: 'json',
        theme: 'vs',
        fontSize: 12,
        lineHeight: 19,
        fontFamily: '"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace',
        minimap: { enabled: false },
        wordWrap: 'on',
        automaticLayout: true,
        tabSize: 2,
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        fixedOverflowWidgets: true,
      });
      this.editor.onDidChangeModelContent(() => {
        const v = this.editor.getValue();
        this.lastEmitted = v;
        this.valueChange.emit(v);
      });
      this.ready.set(true);
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  ngOnDestroy(): void {
    this.editor?.dispose?.();
    this.editor = null;
  }
}