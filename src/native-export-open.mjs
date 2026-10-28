import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

export const nativeExportOpener = {
  available: () => ['darwin', 'win32', 'linux'].includes(process.platform),
  open(path, target) {
    const platform = process.platform;
    const executable = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const args = platform === 'darwin' ? target === 'folder' ? ['-R', path] : [path]
      : platform === 'win32' ? target === 'folder' ? [`/select,${path}`] : [path]
        : [target === 'folder' ? dirname(path) : path];
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('系统未能打开文件，请使用显示的保存路径。')));
    });
  },
};
