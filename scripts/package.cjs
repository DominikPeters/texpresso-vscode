const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.mkdirSync('artifacts', { recursive: true });
const result = spawnSync('vsce', ['package', '--no-dependencies', '--out', 'artifacts/texpresso.vsix'],
  { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) { throw result.error; }
process.exitCode = result.status ?? 1;
