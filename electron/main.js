import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import http from 'node:http';

const isDev = !app.isPackaged;
const sidekickBridgePort = 47631;
let mainWindow = null;
let autoUpdaterInstance = null;
let sidekickBridgeServer = null;
let sidekickLinkedProfile = null;
let sidekickNotifications = [];
let sidekickLogQueue = [];
let updateState = {
  status: isDev ? 'disabled' : 'idle',
  message: isDev ? 'Updates are available after installing the app.' : 'Ready to check for updates.',
  version: '',
  progress: null
};

function pruneSidekickNotifications() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  sidekickNotifications = sidekickNotifications
    .filter((item) => item.createdAt >= cutoff)
    .slice(-100);
}

function addSidekickNotification(payload = {}) {
  const title = String(payload.title || 'Ready for prep').slice(0, 120);
  const message = String(payload.message || '').slice(0, 500);
  if (!message) return null;

  const notification = {
    id: String(payload.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    title,
    message,
    client: String(payload.client || ''),
    device: String(payload.device || ''),
    loan: String(payload.loan || ''),
    crm: String(payload.crm || ''),
    createdAt: Date.now()
  };

  sidekickNotifications.push(notification);
  pruneSidekickNotifications();
  return notification;
}

function setSidekickProfile(profile = null) {
  if (!profile?.id) {
    sidekickLinkedProfile = null;
    return null;
  }

  sidekickLinkedProfile = {
    id: String(profile.id),
    name: String(profile.name || ''),
    role: String(profile.role || ''),
    linkedAt: Date.now()
  };
  return sidekickLinkedProfile;
}

function addSidekickLog(payload = {}) {
  if (!sidekickLinkedProfile?.id || payload.userId !== sidekickLinkedProfile.id) return null;
  const action = String(payload.action || '').slice(0, 120);
  if (!action) return null;

  const log = {
    userId: sidekickLinkedProfile.id,
    userName: sidekickLinkedProfile.name,
    action,
    detail: String(payload.detail || '').slice(0, 1000),
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    occurredAt: new Date().toISOString()
  };

  sidekickLogQueue.push(log);
  sidekickLogQueue = sidekickLogQueue.slice(-500);
  return log;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendBridgeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

function startSidekickBridge() {
  if (sidekickBridgeServer) return;

  sidekickBridgeServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      sendBridgeJson(res, 204, {});
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${sidekickBridgePort}`);

    if (req.method === 'GET' && url.pathname === '/notifications') {
      pruneSidekickNotifications();
      const since = Number(url.searchParams.get('since') || 0);
      const notifications = sidekickNotifications.filter((item) => item.createdAt > since);
      sendBridgeJson(res, 200, {
        ok: true,
        now: Date.now(),
        notifications
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/profile') {
      sendBridgeJson(res, 200, {
        ok: Boolean(sidekickLinkedProfile),
        profile: sidekickLinkedProfile
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/logs') {
      const body = await readJsonBody(req);
      if (!body) {
        sendBridgeJson(res, 400, { ok: false, message: 'Invalid JSON.' });
        return;
      }
      const log = addSidekickLog(body);
      sendBridgeJson(res, log ? 200 : 403, { ok: Boolean(log) });
      return;
    }

    sendBridgeJson(res, 404, { ok: false });
  });

  sidekickBridgeServer.on('error', (error) => {
    console.error('Sidekick notification bridge failed:', error);
    sidekickBridgeServer = null;
  });

  sidekickBridgeServer.listen(sidekickBridgePort, '127.0.0.1');
}

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:state', updateState);
  }
}

async function getAutoUpdater() {
  if (isDev) {
    publishUpdateState({
      status: 'disabled',
      message: 'Updates are available after installing the app.',
      progress: null
    });
    return null;
  }
  if (autoUpdaterInstance) return autoUpdaterInstance;

  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    publishUpdateState({ status: 'checking', message: 'Checking for updates...', progress: null });
  });
  autoUpdater.on('update-available', (info) => {
    publishUpdateState({
      status: 'available',
      message: `Version ${info.version} is available.`,
      version: info.version || '',
      progress: null
    });
  });
  autoUpdater.on('update-not-available', () => {
    publishUpdateState({ status: 'current', message: 'App is up to date.', progress: null });
  });
  autoUpdater.on('download-progress', (progress) => {
    publishUpdateState({
      status: 'downloading',
      message: `Downloading update ${Math.round(progress.percent || 0)}%`,
      progress: Math.round(progress.percent || 0)
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({
      status: 'downloaded',
      message: `Version ${info.version} is ready to install.`,
      version: info.version || updateState.version,
      progress: 100
    });
  });
  autoUpdater.on('error', (error) => {
    publishUpdateState({
      status: 'error',
      message: error?.message || 'Update check failed.',
      progress: null
    });
  });

  autoUpdaterInstance = autoUpdater;
  return autoUpdater;
}

async function checkForUpdates(silent = false) {
  try {
    const autoUpdater = await getAutoUpdater();
    if (!autoUpdater) return updateState;
    if (!silent) publishUpdateState({ status: 'checking', message: 'Checking for updates...', progress: null });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('Update check failed:', error);
    publishUpdateState({ status: 'error', message: error?.message || 'Update check failed.', progress: null });
  }
  return updateState;
}

ipcMain.handle('updates:get-state', () => updateState);
ipcMain.handle('updates:check', () => checkForUpdates(false));
ipcMain.handle('updates:download', async () => {
  try {
    const autoUpdater = await getAutoUpdater();
    if (!autoUpdater) return updateState;
    publishUpdateState({ status: 'downloading', message: 'Starting update download...', progress: 0 });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    console.error('Update download failed:', error);
    publishUpdateState({ status: 'error', message: error?.message || 'Update download failed.', progress: null });
  }
  return updateState;
});
ipcMain.handle('updates:install', async () => {
  const autoUpdater = await getAutoUpdater();
  if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('sidekick:notify-prep', (_event, payload) => addSidekickNotification(payload));
ipcMain.handle('sidekick:set-profile', (_event, profile) => setSidekickProfile(profile));
ipcMain.handle('sidekick:clear-profile', () => setSidekickProfile(null));
ipcMain.handle('sidekick:get-profile', () => sidekickLinkedProfile);
ipcMain.handle('sidekick:take-logs', () => sidekickLogQueue.splice(0));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: 'Trials Operations Dashboard',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  startSidekickBridge();
  createWindow();
  setTimeout(() => checkForUpdates(true), 3000);
});

app.on('before-quit', () => {
  if (sidekickBridgeServer) {
    sidekickBridgeServer.close();
    sidekickBridgeServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
