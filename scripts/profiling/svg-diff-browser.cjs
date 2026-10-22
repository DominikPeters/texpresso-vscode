#!/usr/bin/env node
/* Local experimental SVG DOM benchmark; deliberately separate from production. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { canonicalSvg, diffSvg } = require('../../out/svg-patch');
const root = path.resolve(process.argv[2] || 'artifacts/profile-svg-diff');
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1:9384').pathname;
  if (name === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, 'svg-diff.html')));
  } else if (name === '/validation') {
    res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'svg-validation.html')));
  } else if (name === '/preview-svg.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(__dirname, '../../media/preview-svg.js')));
  } else if (name === '/validation.json') {
    const jobs = [];
    const kinds = ['sparse', 'dense', 'packed', 'tikz'];
    if (fs.existsSync(path.join(root, 'math-baseline.svg'))) kinds.push('math');
    for (const kind of kinds) for (const edit of ['inserted', 'font']) {
      const before = canonicalSvg(fs.readFileSync(path.join(root, kind + '-baseline.svg'), 'utf8'), 1000);
      const after = canonicalSvg(fs.readFileSync(path.join(root, kind + '-' + edit + '.svg'), 'utf8'), 1000);
      jobs.push({ kind, edit, before: before.text, after: after.text, originalAfter: fs.readFileSync(path.join(root, kind + '-' + edit + '.svg'), 'utf8'), patch: diffSvg(before, after, 'before', { maxMs: 1000 }) });
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(jobs));
  } else if (name === '/validation-result' && req.method === 'POST') {
    let text = ''; for await (const part of req) text += part;
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(JSON.parse(text), null, 2)); res.end('ok');
  } else if (name === '/result' && req.method === 'POST') {
    let body = ''; for await (const part of req) body += part;
    fs.writeFileSync(path.join(root, 'browser.json'), JSON.stringify(JSON.parse(body), null, 2));
    res.end('ok');
  } else if (/^\/(sparse|dense|packed|tikz)-(baseline|inserted|font)\.svg$/.test(name) || /^\/(sparse|dense|packed|tikz)-(inserted|font)-dom\.json$/.test(name)) {
    res.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : 'application/json');
    res.end(fs.readFileSync(path.join(root, name.slice(1))));
  } else { res.writeHead(404); res.end(); }
});
server.listen(9384, '127.0.0.1', () => console.log('SVG DOM probe: http://127.0.0.1:9384'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); process.exit(0); });
