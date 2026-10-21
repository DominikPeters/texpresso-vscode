// A real child process speaking the editor protocol, for VS Code host tests.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.argv.at(-1);
const trace = event => fs.appendFileSync(process.env.TEXPRESSO_TEST_TRACE, JSON.stringify(event) + '\n');
trace({ type: 'start', pid: process.pid, root, args: process.argv.slice(2) });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let opened = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  trace({ type: 'command', pid: process.pid, command });
  if (command[0] === 'open' && !opened) {
    opened = true;
    send(['input-file', 1, path.join(path.dirname(root), 'chapter.tex')]);
    send(['append-lines', 'out', 'TeXpresso integration fixture: document compiled.']);
    send(['flush']);
  } else if (command[0] === 'change-range' || command[0] === 'change') {
    send(['flush']);
  }
});
