const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Expand test files ourselves: Windows shells do not expand globs, and test
// discovery must not load the VS Code-only integration suite into plain Node.
const directory = path.resolve(__dirname, '../out/test', process.argv[2] || '');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.test.js'))
  .map(file => path.join(directory, file));
// Native engines share a format cache. Concurrent cold starts can read a
// partially written .fmt while another test file is generating it.
const concurrency = process.argv[2] === 'engine' ? ['--test-concurrency=1'] : [];
// Legacy-window coverage must not steal focus on every engine start/restart.
// Showing native windows is an explicit, local manual-test opt-in.
const env = { ...process.env };
if (process.argv[2] === 'engine' && env.TEXPRESSO_TEST_NATIVE_WINDOW !== '1') {
  env.SDL_VIDEODRIVER = 'dummy';
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...concurrency, ...files], { stdio: 'inherit', env });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
