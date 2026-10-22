import { execFile } from 'child_process';
import type { SessionConfiguration, LaunchCommand } from './configuration';
import { processFailure } from './failures';

export function probePreview(config: SessionConfiguration, cwd?: string, features?: (value: { regions: boolean; svg: boolean; links: boolean; auto: boolean; pngPatches: boolean }) => void): Promise<boolean> {
  const launch: LaunchCommand = config.useWSL
    ? { command: 'wsl', args: ['-e', config.command, '-capabilities'] }
    : { command: config.command, args: ['-capabilities'], cwd };
  return new Promise((resolve, reject) => {
    execFile(launch.command, launch.args, { cwd: launch.cwd, timeout: 3000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      if (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) { reject(processFailure(error, 'launch')); }
        else { resolve(false); }
        return;
      }
      try {
        const capabilities = JSON.parse(stdout);
        features?.({ regions: capabilities?.regions === true, svg: capabilities?.codecs?.includes('svg') === true, links: capabilities?.links === true, auto: capabilities?.adaptiveRendering === true, pngPatches: capabilities?.pngPatches === true });
        resolve(capabilities?.previewProtocol === 1 && Array.isArray(capabilities.codecs) &&
          capabilities.codecs.includes('png') && capabilities.synctex === true);
      } catch { resolve(false); }
    });
  });
}
