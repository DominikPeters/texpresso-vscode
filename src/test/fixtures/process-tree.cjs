const { spawn } = require('node:child_process');
if (process.argv.includes('worker')) {
  process.on('SIGTERM', () => {});
  process.stdout.write(JSON.stringify({ worker: process.pid }) + '\n');
  setInterval(() => {}, 1000);
} else {
  // Deliberately ignore TERM in both processes, like a stalled native engine.
  process.on('SIGTERM', () => {});
  spawn(process.execPath, [__filename, 'worker'], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.stdout.write(JSON.stringify({ parent: process.pid }) + '\n');
  setInterval(() => {}, 1000);
}
