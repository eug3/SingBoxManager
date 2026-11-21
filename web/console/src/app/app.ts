import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { BackendPane } from './backend-pane';
import { RuleEditor } from './rule-editor';
import { BackendsService } from './backends.service';
import { PAGE_ORIGINS } from './models';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackendPane, RuleEditor],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly bsvc = inject(BackendsService);
  readonly backends = this.bsvc.backends;
  readonly active = signal<string>(this.backends().length ? 'b0' : 'edit');
  readonly originOk = PAGE_ORIGINS.includes(location.origin);
  readonly origins = PAGE_ORIGINS;
  readonly keyDraft = signal(this.bsvc.globalKey());

  onKey(v: string): void {
    this.keyDraft.set(v);
    this.bsvc.setGlobalKey(v);
  }

  addBackend(): void {
    const i = this.bsvc.addDraft();
    this.active.set('b' + i);
  }

  onRemoved(): void {
    this.active.set(this.backends().length ? 'b0' : 'edit');
  }
}