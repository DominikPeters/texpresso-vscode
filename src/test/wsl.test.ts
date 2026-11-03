import { test, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import childProcess = require('node:child_process');
import { wslArguments, distributionPaths } from '../wsl';
import { buildLaunchCommand } from '../configuration';
import { SessionPaths } from '../paths';
import { config } from './helpers';

test('a named WSL distribution is passed as one argument for commands and cached path conversions', () => {
  const distribution = 'Ubuntu custom & test';
  const calls: string[][] = [];
  const mocked = mock.method(childProcess, 'execFileSync', (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    return args.includes('-u') ? '/mnt/c/paper with spaces/main.tex\n' : 'C:\\paper with spaces\\main.tex\n';
  });
  try {
    const paths = distributionPaths(distribution);
    assert.equal(paths.toEngine('C:\\paper with spaces\\main.tex'), '/mnt/c/paper with spaces/main.tex');
    paths.toEngine('C:\\paper with spaces\\main.tex');
    assert.equal(calls.length, 1, 'editing the same file reuses its conversion');
    paths.toEditor('/mnt/c/paper with spaces/main.tex');
    assert.deepEqual(calls[0], ['--distribution', distribution, '-e', 'wslpath', '-u', 'C:\\paper with spaces\\main.tex']);
    assert.deepEqual(calls[1], ['--distribution', distribution, '-e', 'wslpath', '-w', '/mnt/c/paper with spaces/main.tex']);
    assert.deepEqual(wslArguments('texpresso', ['-capabilities'], distribution),
      ['--distribution', distribution, '-e', 'texpresso', '-capabilities']);
    const sessionPaths = new SessionPaths('C:\\paper\\main.tex', true,
      { toEngine: () => '/mnt/c/paper/main.tex', toEditor: value => value }, distribution);
    const launch = buildLaunchCommand({ ...config, useWSL: true, wslDistribution: distribution }, sessionPaths);
    assert.deepEqual(launch.args.slice(0, 4), ['--distribution', distribution, '-e', 'texpresso']);
    assert.equal(sessionPaths.wslDistribution, distribution);
  } finally { mocked.mock.restore(); }
});
