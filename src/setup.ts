import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildLaunchCommand, SessionConfiguration } from './configuration';
import { SessionPaths } from './paths';

// Resolve on the extension host, whose PATH can differ from an interactive shell.
export async function findExecutable(command: string, cwd: string): Promise<string | undefined> {
  const directories = /[\\/]/.test(command) ? [''] : (process.env.PATH || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' && !path.extname(command)
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, directory, command + suffix);
      try {
        await fs.promises.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.promises.stat(candidate)).isFile()) {
          return candidate;
        }
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}

function inWsl(directory: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl', ['-e', 'sh', '-c', 'cd "$1" && command -v "$2"', 'texpresso-check', directory, command],
      { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout.trim());
        }
      });
  });
}

export async function setupReport(configuration: SessionConfiguration, paths: SessionPaths,
  host: string): Promise<string> {
  const lines = ['TeXpresso Setup', '', 'Extension host: ' + host,
    'Main document: ' + paths.rootEditorPath,
    'Execution: ' + (configuration.useWSL ? 'Windows → WSL' : 'Directly on the extension host'),
    'Package provider: ' + configuration.packageProvider,
    'Edit protocol: ' + (configuration.useChangeRangeMode ? 'UTF-16 ranges' : 'Legacy UTF-8 byte offsets'), ''];
  try {
    const launch = buildLaunchCommand(configuration, paths);
    lines.push('Working directory: ' + (launch.cwd || paths.engineDirectory),
      'Launch command (JSON array; each item is one argument):', JSON.stringify([launch.command, ...launch.args], null, 2), '');
    const resolved = configuration.useWSL
      ? await inWsl(paths.engineDirectory, configuration.command)
      : await findExecutable(configuration.command, paths.engineDirectory);
    lines.push(resolved ? 'Executable found: ' + resolved : 'Executable NOT FOUND: ' + configuration.command);
    for (const command of ['kpsewhich', 'tectonic']) {
      let found: string | undefined;
      try {
        found = configuration.useWSL ? await inWsl(paths.engineDirectory, command)
          : await findExecutable(command, paths.engineDirectory);
      } catch { /* An absent package provider is useful information, not a failed report. */ }
      lines.push(command + ': ' + (found || 'not found on PATH'));
    }
    lines.push('', 'These checks locate executables; they do not verify engine compatibility or compile a document.',
      'TeXpresso does not currently provide a reliable version/capability query.',
      'For Remote WSL windows, leave texpresso.useWSL disabled.');
  } catch (error) {
    lines.push('Setup check failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  return lines.join('\n') + '\n';
}
