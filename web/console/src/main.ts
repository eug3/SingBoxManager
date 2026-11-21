/**
 * main.ts — Angular 应用入口（bootstrap）。
 *
 * 以 standalone 根组件 App + appConfig 启动；无 NgModule、无路由库
 * （主 tab / 子 tab 均由信号切换）。启动失败仅打印错误，便于在控制台定位。
 */
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
