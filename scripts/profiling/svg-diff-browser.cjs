#!/usr/bin/env node
/* Local experimental SVG DOM benchmark; deliberately separate from production. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(process.argv[2] || 'artifacts/profile-svg-diff');
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1:9384').pathname;
  if (name === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, 'svg-diff.html')));
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
