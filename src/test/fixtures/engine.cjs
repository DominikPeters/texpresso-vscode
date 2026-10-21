// A real child process speaking the editor protocol, for VS Code host tests.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.argv.at(-1);
const trace = event => fs.appendFileSync(process.env.TEXPRESSO_TEST_TRACE, JSON.stringify(event) + '\n');
trace({ type: 'start', pid: process.pid, root, args: process.argv.slice(2) });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let opened = false;
let paused = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  trace({ type: 'command', pid: process.pid, command });
  if (command[0] === 'open' && !opened) {
    opened = true;
    send(['input-file', 1, path.join(path.dirname(root), 'chapter.tex')]);
    send(['lookup-file', 'read', 'successful', 'plot.bin']);
    send(['lookup-file', 'read', fs.existsSync(path.join(path.dirname(root), 'future.tex')) ? 'successful' : 'failed', 'future.tex']);
    send(['lookup-file', 'write', 'successful', path.basename(root).replace(/\.tex$/, '.aux')]);
    send(['append-lines', 'out', 'TeXpresso integration fixture: document compiled.']);
    send(['flush']);
  } else if (command[0] === 'pause') {
    paused = true;
  } else if (command[0] === 'resume') {
    paused = false;
    send(['flush']);
  } else if (!paused && ['change-range', 'change', 'rescan', 'rerun-once'].includes(command[0])) {
    send(['flush']);
  }
});
