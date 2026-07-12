const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extractSunoStems } = require('./sunoStems');

let mainWindow;

const previewDir = path.join(os.tmpdir(), 'spotify-worthy-preview');
if (!fs.existsSync(previewDir)) {
  fs.mkdirSync(previewDir, { recursive: true });
}
const stemsTempDir = path.join(previewDir, 'stems');
if (!fs.existsSync(stemsTempDir)) {
  fs.mkdirSync(stemsTempDir, { recursive: true });
}

const importFileFilter = {
  name: 'Audio Files and Suno Stem Archives',
  extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'mp4', 'zip']
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 1050,
    minHeight: 750,
    frame: false,
    // macOS keeps its traffic-light controls when the title bar is hidden.
    // Use the inset variant and let the renderer reserve room for them.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, '../image.png')
  });

  // Always try to load from dist first, fall back to dev server
  const distPath = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath);
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(distPath);
  }
  
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

// Window control handlers
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

// File selection
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [importFileFilter]
  });
  return result.filePaths[0] || null;
});

// Batch file selection (multiple files)
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [importFileFilter]
  });
  return result.filePaths || [];
});

// Select output directory for batch export
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0] || null;
});

// Build batch output paths in the main process so the native path separator is
// always used. The renderer runs in a browser context and must not guess it.
ipcMain.handle('get-batch-output-path', (event, outputDir, baseName) => {
  if (!outputDir || !baseName) {
    throw new Error('Output directory and file name are required');
  }
  return path.join(outputDir, `${baseName}_mastered.wav`);
});

// Save file dialog
ipcMain.handle('save-file', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'WAV File', extensions: ['wav'] }]
  });
  return result.filePath || null;
});

// Read audio file
ipcMain.handle('read-audio-file', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('File not found');
  }
  
  try {
    const buffer = fs.readFileSync(filePath);
    return new Uint8Array(buffer);
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
});

// Extract a Suno stem export into a private temporary folder. The renderer only
// receives the resulting audio paths, never direct filesystem access.
ipcMain.handle('import-suno-stems', async (event, archivePath) => {
  if (!archivePath || path.extname(archivePath).toLowerCase() !== '.zip' || !fs.existsSync(archivePath)) {
    throw new Error('Suno stems ZIP not found');
  }
  return extractSunoStems(archivePath, stemsTempDir);
});

// Write file (for WAV export)
ipcMain.handle('write-file', async (event, filePath, data) => {
  if (!filePath) {
    throw new Error('No file path specified');
  }
  
  try {
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
});

// Get system info
ipcMain.handle('get-system-info', () => ({
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node
}));

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  try {
    if (fs.existsSync(previewDir)) {
      fs.rmSync(previewDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup error:', e);
  }
});
