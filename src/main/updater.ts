import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from './config-store';

/**
 * 自动更新（doc/优化方案 T5.6）。
 *
 * 发布源不硬编码在代码里，按以下优先级解析：
 *   1. 环境变量 ZBOT_UPDATE_FEED_URL
 *   2. ~/.z-bot/update-feed.json  ->  { "url": "https://example.com/zbot", "channel": "latest" }
 *   3. electron-builder 配置里的 publish 段（打包时已写入 latest.yml）
 *
 * 没配发布源时只回报原因，不去真的发请求 —— electron-updater 在无源/开发态会抛错。
 */

export interface UpdateCheckResult {
  ok: boolean;
  status: 'available' | 'not-available' | 'dev-mode' | 'no-feed' | 'error' | 'downloaded';
  version?: string;
  reason?: string;
}

const FEED_FILE = path.join(dataDir, 'update-feed.json');

export interface FeedConfig {
  url: string;
  channel?: string;
}

export function readFeed(): FeedConfig | null {
  const fromEnv = process.env.ZBOT_UPDATE_FEED_URL;
  if (fromEnv && /^https?:\/\//i.test(fromEnv.trim())) {
    return { url: fromEnv.trim() };
  }
  try {
    if (!fs.existsSync(FEED_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(FEED_FILE, 'utf-8'));
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, channel: typeof parsed.channel === 'string' ? parsed.channel : undefined };
  } catch (e: any) {
    console.warn('[Updater] 读取 update-feed.json 失败:', e.message);
    return null;
  }
}

let lastResult: UpdateCheckResult = { ok: false, status: 'no-feed', reason: '尚未检查更新' };
let wiring: ((channel: string, payload: any) => void) | null = null;
let wired = false;

export function initUpdater(broadcast: (channel: string, payload: any) => void): void {
  wiring = broadcast;
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false; // 由用户点确认后再下载，避免静默占带宽
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    lastResult = { ok: false, status: 'error', reason: err?.message || '更新检查失败' };
    wiring?.('update:status', lastResult);
  });
  autoUpdater.on('update-available', (info) => {
    lastResult = { ok: true, status: 'available', version: info?.version };
    wiring?.('update:status', lastResult);
  });
  autoUpdater.on('update-not-available', (info) => {
    lastResult = { ok: true, status: 'not-available', version: info?.version };
    wiring?.('update:status', lastResult);
  });
  autoUpdater.on('download-progress', (p) => {
    wiring?.('update:progress', { percent: Math.round(p?.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    lastResult = { ok: true, status: 'downloaded', version: info?.version };
    wiring?.('update:status', lastResult);
  });
}

export function getUpdateStatus(): UpdateCheckResult {
  return lastResult;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    lastResult = {
      ok: false,
      status: 'dev-mode',
      reason: '开发模式下不检查更新（ electron-updater 需要打包后的 app-update.yml）',
    };
    return lastResult;
  }
  const feed = readFeed();
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url, channel: feed.channel });
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e: any) {
    lastResult = {
      ok: false,
      status: 'no-feed',
      reason: e?.message?.slice(0, 200) || '未配置发布源：设置 ZBOT_UPDATE_FEED_URL 或 ~/.z-bot/update-feed.json',
    };
  }
  return lastResult;
}

/** 用户确认后才真正下载并退出安装 */
export async function downloadAndInstall(): Promise<{ ok: boolean; reason?: string }> {
  if (!app.isPackaged) return { ok: false, reason: '开发模式下不可用' };
  try {
    await autoUpdater.downloadUpdate();
    setImmediate(() => {
      (app as any).isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message?.slice(0, 200) };
  }
}
