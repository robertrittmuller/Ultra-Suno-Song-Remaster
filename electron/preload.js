const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getBatchOutputPath: (outputDir, baseName) => ipcRenderer.invoke('get-batch-output-path', outputDir, baseName),
  saveFile: () => ipcRenderer.invoke('save-file'),
  readAudioFile: (filePath) => ipcRenderer.invoke('read-audio-file', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close')
});
