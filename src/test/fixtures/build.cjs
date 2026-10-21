const fs = require('node:fs');
const root = process.argv.at(-1);
fs.writeFileSync(root.replace(/\.tex$/, '.aux'), '\\relax\n');
fs.appendFileSync(process.env.TEXPRESSO_TEST_TRACE, JSON.stringify({ type: 'build', root }) + '\n');
console.log('External build fixture completed.');
