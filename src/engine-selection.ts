import * as fs from 'fs';
import * as path from 'path';
import type { SessionConfiguration } from './configuration';
import { EngineFailure } from './failures';

/** Select on the extension host, which is Linux in a Remote WSL window. */
export function resolveEngine(configuration: SessionConfiguration, extensionPath: string,
  platform: NodeJS.Platform = process.platform, architecture: string = process.arch): SessionConfiguration {
  const config = { ...configuration, useWSL: platform === 'win32' && configuration.useWSL };
  if (config.command.trim()) { return { ...config, engineSource: 'custom' }; }
  if (config.useWSL) { return { ...config, command: 'texpresso', engineSource: 'path' }; }
  const runtime = path.join(extensionPath, 'runtime');
  if (!fs.existsSync(runtime)) { return { ...config, command: 'texpresso', engineSource: 'path' }; }
  const target = platform + '-' + architecture;
  const directory = path.join(runtime, target);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json'), 'utf8'));
    const arch = manifest.architecture === 'x86_64' ? 'x64' : manifest.architecture;
    if (manifest.platform !== platform || arch !== architecture || !/^[a-f0-9]{40}$/.test(manifest.engineRevision)) {
      throw new Error('The native build manifest does not match ' + target + '.');
    }
    for (const name of ['texpresso', 'texpresso-xetex']) {
      const binary = path.join(directory, 'bin', name);
      if (!fs.statSync(binary).isFile()) { throw new Error(name + ' is not a file.'); }
      fs.accessSync(binary, fs.constants.X_OK);
    }
    return { ...config, command: path.join(directory, 'bin', 'texpresso'),
      engineSource: 'bundled', engineRevision: manifest.engineRevision };
  } catch (error) {
    throw new EngineFailure('configuration', 'The bundled engine for ' + target +
      ' is unavailable or damaged. Reinstall the matching TeXpresso VSIX, or set an external engine path. ' +
      (error instanceof Error ? error.message : String(error)), 'BUNDLE_INVALID');
  }
}
