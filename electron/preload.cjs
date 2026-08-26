const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboardUpdates', {
  getState: () => ipcRenderer.invoke('updates:get-state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  install: () => ipcRenderer.invoke('updates:install'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  }
});

contextBridge.exposeInMainWorld('dashboardSidekick', {
  notifyPrep: (payload) => ipcRenderer.invoke('sidekick:notify-prep', payload),
  setProfile: (profile) => ipcRenderer.invoke('sidekick:set-profile', profile),
  clearProfile: () => ipcRenderer.invoke('sidekick:clear-profile'),
  getProfile: () => ipcRenderer.invoke('sidekick:get-profile'),
  takeLogs: () => ipcRenderer.invoke('sidekick:take-logs')
});
