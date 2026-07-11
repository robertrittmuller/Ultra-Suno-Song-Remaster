// Type declarations for Electron API
interface ElectronAPI {
  platform: string;
  selectFile: () => Promise<string | null>;
  selectFiles: () => Promise<string[]>;
  selectDirectory: () => Promise<string | null>;
  saveFile: () => Promise<string | null>;
  readAudioFile: (filePath: string) => Promise<number[]>;
  importSunoStems: (archivePath: string) => Promise<Array<{ name: string; path: string }>>;
  writeFile: (filePath: string, data: number[]) => Promise<{ success: boolean }>;
  getPathForFile: (file: File) => string;
  getSystemInfo: () => Promise<{
    platform: string;
    arch: string;
    isPackaged: boolean;
    appPath: string;
    electronVersion: string;
    nodeVersion: string;
  }>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
}

interface Window {
  electronAPI: ElectronAPI;
}
