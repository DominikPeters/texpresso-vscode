#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const root = path.resolve(process.argv[2] || 'artifacts/profile-png-regions');
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1:9385').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'png-regions.html'))); }
  else if (name === '/regions.json') { res.setHeader('Content-Type', 'application/json'); res.end(fs.readFileSync(path.join(root, 'regions.json'))); }
  else if (name === '/result' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    fs.writeFileSync(path.join(root, 'browser.json'), JSON.stringify(JSON.parse(text), null, 2)); res.end('ok');
  } else if (/^\/(sparse|dense|packed|tikz)-(letter|reflow|coordinate)-(before|after|forward|backward)\.png$/.test(name)) {
    res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(root, name.slice(1))));
  } else { res.writeHead(404); res.end(); }
});
server.listen(9385, '127.0.0.1', () => console.log('PNG regions: http://127.0.0.1:9385'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); process.exit(0); });
