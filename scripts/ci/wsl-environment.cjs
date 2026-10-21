// CI-only lifecycle for a prepared Ubuntu image. Export before copying any
// checkout into the distro, so the cache contains packages, not Git credentials.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('This script manages disposable Windows GitHub Actions WSL distributions only.');
}
const temporary = process.env.RUNNER_TEMP;
if (!temporary) { throw new Error('RUNNER_TEMP is required'); }
const archive = path.join(temporary, 'texpresso-wsl.tar');
const timer = path.join(temporary, 'texpresso-wsl-start.json');
const wsl = args => execFileSync('wsl', args, { stdio: 'inherit', timeout: 600000 });
const check = () => wsl(['-e', 'sh', '-ec', 'command -v gcc; command -v kpsewhich; kpsewhich article.cls; command -v ps']);
const summary = (source, started) => {
  const elapsed = ((Date.now() - JSON.parse(fs.readFileSync(timer, 'utf8')).started) / 1000).toFixed(1);
  const operation = ((Date.now() - started) / 1000).toFixed(1);
  const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(0);
  const text = `### Prepared WSL distribution\n\n| Measure | Value |\n| --- | --- |\n| Setup | ${source} |\n| Setup elapsed, including cache lookup/download | ${elapsed} s |\n| WSL import/export step and validation | ${operation} s |\n| Uncompressed archive | ${size} MiB |\n\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text); }
};

switch (process.argv[2]) {
  case 'configure': {
    const packages = fs.readFileSync(path.join(__dirname, 'wsl-packages.txt'), 'utf8').trim().split(/\s+/);
    if (!packages.every(name => /^[a-z0-9][a-z0-9+.-]*$/.test(name))) { throw new Error('Invalid WSL package name'); }
    fs.writeFileSync(timer, JSON.stringify({ started: Date.now() }));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'packages=' + packages.join(' ') + '\n');
    break;
  }
  case 'import': {
    const started = Date.now();
    // setup-wsl updates the Windows WSL runtime on cold runs. The filesystem
    // archive cannot include that host component, so prepare it on cache hits.
    wsl(['--update']);
    wsl(['--import', 'TeXpresso-CI', path.join(temporary, 'texpresso-wsl-distro'), archive, '--version', '2']);
    wsl(['--set-default', 'TeXpresso-CI']);
    check();
    summary('Cache hit', started);
    break;
  }
  case 'export': {
    const started = Date.now();
    check();
    wsl(['-e', 'sh', '-ec', 'test ! -e /opt/texpresso; apt-get clean']);
    wsl(['--terminate', 'Ubuntu-24.04']);
    wsl(['--export', 'Ubuntu-24.04', archive]);
    summary('Cold installation; exported for caching', started);
    break;
  }
  case 'build': {
    // An imported distro has no setup-wsl shell wrapper. Use wsl.exe directly
    // on both paths, passing the checkout path as an argument rather than code.
    const source = execFileSync('wsl', ['-e', 'wslpath', '-a', '-u', path.resolve('.engine')],
      { encoding: 'utf8', timeout: 30000 }).trim();
    wsl(['-e', 'sh', '-ec', 'mkdir -p /opt/texpresso; cp -a "$1/." /opt/texpresso/; make -C /opt/texpresso -j2 all', 'texpresso-build', source]);
    break;
  }
  default: throw new Error('Expected configure, import, export, or build');
}
