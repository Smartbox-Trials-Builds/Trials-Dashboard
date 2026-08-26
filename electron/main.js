import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';

const isDev = !app.isPackaged;
let mainWindow = null;
let autoUpdaterInstance = null;
let updateState = {
  status: isDev ? 'disabled' : 'idle',
  message: isDev ? 'Updates are available after installing the app.' : 'Ready to check for updates.',
  version: '',
  progress: null
};

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
  createWindow();
  setTimeout(() => checkForUpdates(true), 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
