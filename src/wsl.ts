import { execFileSync } from 'child_process';
import type { PathConversion } from './paths';

export function wslArguments(command: string, args: readonly string[], distribution = ''): string[] {
  return [...(distribution ? ['--distribution', distribution] : []), '-e', command, ...args];
}

/** A session-local cache prevents repeated wsl.exe launches during editing. */
export function distributionPaths(distribution: string): PathConversion {
  const engine = new Map<string, string>(), editor = new Map<string, string>();
  const convert = (value: string, flag: string, cache: Map<string, string>) => {
    let result = cache.get(value);
    if (result === undefined) {
      result = execFileSync('wsl', wslArguments('wslpath', [flag, value], distribution),
        { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      if (!result) { throw new Error('WSL did not convert the path: ' + value); }
      cache.set(value, result);
    }
    return result;
  };
  return { toEngine: value => convert(value, '-u', engine), toEditor: value => convert(value, '-w', editor) };
}
