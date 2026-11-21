import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';

/**
 * app.config.ts — 应用级 providers。
 * zoneless（无 zone.js，靠 signals 驱动变更检测）+ HttpClient(fetch 后端)。
 * 无路由库：主 tab / 子 tab 均由信号切换。
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withFetch())],
};
