import { execFile } from 'child_process';
import type { SessionConfiguration, LaunchCommand } from './configuration';
import { EngineFailure, processFailure } from './failures';
import { wslArguments } from './wsl';

export function probePreview(config: SessionConfiguration, cwd?: string, features?: (value: { regions: boolean; svg: boolean; links: boolean; auto: boolean; pngPatches: boolean; background: boolean; prepareEdit: boolean; requestLifecycle?: boolean; synctexPrecision?: boolean }) => void): Promise<boolean> {
  const launch: LaunchCommand = config.useWSL
    ? { command: 'wsl', args: wslArguments(config.command, ['-capabilities'], config.wslDistribution) }
    : { command: config.command, args: ['-capabilities'], cwd };
  return new Promise((resolve, reject) => {
    // A freshly installed binary can spend several seconds in cold OS loading.
    execFile(launch.command, launch.args, { cwd: launch.cwd, timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      if (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) { reject(processFailure(error, 'launch')); }
        else if (error.killed && error.signal === 'SIGTERM' && !error.code) {
          reject(new EngineFailure('launch', 'TeXpresso did not answer its capability check within 10 seconds. Try starting the preview again.', 'ETIMEDOUT'));
        } else { resolve(false); }
        return;
      }
      try {
        const capabilities = JSON.parse(stdout);
        features?.({ regions: capabilities?.regions === true, svg: capabilities?.codecs?.includes('svg') === true, links: capabilities?.links === true, auto: capabilities?.adaptiveRendering === true, pngPatches: capabilities?.pngPatches === true, background: capabilities?.backgroundRendering === true, prepareEdit: capabilities?.prepareEdit === true, requestLifecycle: capabilities?.requestLifecycle === true, synctexPrecision: capabilities?.synctexPrecision === 1 });
        resolve(capabilities?.previewProtocol === 1 && Array.isArray(capabilities.codecs) &&
          capabilities.codecs.includes('png') && capabilities.synctex === true);
      } catch { resolve(false); }
    });
  });
}
