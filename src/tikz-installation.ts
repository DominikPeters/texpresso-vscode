import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Probe = (file: string, args: string[]) => Promise<string>;
const probe: Probe = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 2000, maxBuffer: 65536, windowsHide: true },
    (error, stdout) => resolve(error ? '' : stdout.trim()));
});

export async function usableEditor(candidate: string, platform = process.platform, run: Probe = probe): Promise<string | undefined> {
  if (!path.isAbsolute(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) { return; }
  try {
    if (platform === 'darwin' && candidate.toLowerCase().endsWith('.app')) {
      // Tauri bundles declare their executable; it is not necessarily tikz-editor.
      const executable = await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-',
        path.join(candidate, 'Contents', 'Info.plist')]);
      if (!executable || executable === '.' || executable === '..' || /[\\/\x00-\x1f\x7f]/.test(executable)) { return; }
      candidate = path.join(candidate, 'Contents', 'MacOS', executable);
    }
    if (!(await fs.stat(candidate)).isFile()) { return; }
    await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return candidate;
  } catch { return; }
}

export async function findTikzEditor(override = '', options: {
  platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; run?: Probe;
} = {}): Promise<string | undefined> {
  const platform = options.platform || process.platform, home = options.home || os.homedir();
  const env = options.env || process.env, run = options.run || probe;
  if (override) { return usableEditor(override, platform, run); }
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(path.join(home, 'Applications/TikZ Editor.app'), '/Applications/TikZ Editor.app');
    for (const candidate of candidates) { const usable = await usableEditor(candidate, platform, run); if (usable) { return usable; } }
    candidates.push(...(await run('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.tikz.editor"'])).split(/\r?\n/).filter(Boolean));
  } else if (platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      const value = await run(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', hive + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\tikz-editor.exe', '/ve']);
      const registered = value.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1].trim();
      if (registered) { candidates.push(registered.replace(/%([^%]+)%/g, (match, key) =>
        Object.entries(env).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] || match)); }
    }
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles]) {
      if (base) { candidates.push(path.join(base, 'TikZ Editor/tikz-editor.exe')); }
    }
  } else if (platform === 'linux') {
    const locations = [env.XDG_DATA_HOME || path.join(home, '.local/share'),
      ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    for (const location of locations.filter(p => path.isAbsolute(p))) {
      for (const name of ['com.tikz.editor.desktop', 'tikz-editor.desktop', 'TikZ Editor.desktop']) {
        try {
          const file = path.join(location, 'applications', name);
          if ((await fs.stat(file)).size > 65536) { continue; }
          const text = await fs.readFile(file, 'utf8');
          const desktop = text.split('[Desktop Entry]')[1]?.split(/\n\[/)[0];
          const exec = desktop?.match(/^Exec=(?:"([^"\\]+)"|([^\s"\\]+))\s*((?:%[fFuU]\s*)?)$/m);
          if (exec) {
            const command = exec[1] || exec[2];
            // Complex launchers (flatpak, shell wrappers with arguments) need an
            // explicit executable setting rather than evaluating desktop code.
            if (path.isAbsolute(command)) { candidates.push(command); }
            else if (!command.includes('/')) {
              for (const directory of (env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p))) {
                candidates.push(path.join(directory, command));
              }
            }
          }
        } catch { /* Unregistered application. */ }
      }
    }
  }
  for (const directory of (env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p))) {
    candidates.push(path.join(directory, platform === 'win32' ? 'tikz-editor.exe' : 'tikz-editor'));
  }
  for (const candidate of new Set(candidates)) {
    const usable = await usableEditor(candidate, platform, run);
    if (usable) { return usable; }
  }
  return;
}
