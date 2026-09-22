import type { ElectronApi } from '../preload/index';

/**
 * window.electronAPI 的类型直接派生自 preload 真实暴露的对象。
 * 手写副本曾声明过 preload 里根本不存在的方法（toolsCancel / sendNotification），
 * 导致编译期看不出、运行期拿到 undefined。
 */
declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

export {};
