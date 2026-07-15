'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');

if (fs.existsSync(pathFile)) {
  process.exit(0);
}

if (!fs.existsSync(electronDir)) {
  console.error('Electron is missing after dependency installation.');
  process.exit(1);
}

const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;

if (platform === 'darwin') {
  installMacElectron().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
} else {
  // Electron's own installer handles Windows and Linux normally. The interval
  // retains an event-loop handle for Node 26 while its asynchronous extraction
  // finishes.
  const timeoutMs = 5 * 60 * 1000;
  let completed = false;
  let waitChecks = 0;
  const keepAlive = setInterval(() => {
    if (fs.existsSync(pathFile)) {
      completed = true;
      clearInterval(keepAlive);
      clearTimeout(timeout);
      console.log('Electron binary installation completed.');
    } else if (++waitChecks % 50 === 0) {
      console.log('Waiting for Electron binary installation to finish...');
    }
  }, 100);

  const timeout = setTimeout(() => {
    if (!completed) {
      clearInterval(keepAlive);
      console.error('Electron binary installation timed out before path.txt was created.');
      process.exitCode = 1;
    }
  }, timeoutMs);

  try {
    require(path.join(electronDir, 'install.js'));
  } catch (error) {
    clearInterval(keepAlive);
    clearTimeout(timeout);
    console.error(error);
    process.exitCode = 1;
  }
}

async function installMacElectron() {
  const { version } = require(path.join(electronDir, 'package.json'));
  const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronDir] }));
  let arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;

  if (process.arch === 'x64' && arch === 'x64' && process.env.npm_config_arch === undefined) {
    try {
      if (childProcess.execSync('sysctl -in sysctl.proc_translated').toString().trim() === '1') {
        arch = 'arm64';
      }
    } catch {
      // Not running under Rosetta.
    }
  }

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    cacheRoot: process.env.electron_config_cache,
    checksums: process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
      ? undefined
      : require(path.join(electronDir, 'checksums.json')),
    platform,
    arch
  });

  const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');
  childProcess.execFileSync('unzip', ['-oq', zipPath, '-d', distPath], { stdio: 'inherit' });

  const declarationInDist = path.join(distPath, 'electron.d.ts');
  if (fs.existsSync(declarationInDist)) {
    fs.renameSync(declarationInDist, path.join(electronDir, 'electron.d.ts'));
  }

  fs.writeFileSync(pathFile, 'Electron.app/Contents/MacOS/Electron');
  console.log('Electron binary installation completed.');
}
