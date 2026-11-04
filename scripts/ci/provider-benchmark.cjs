// All installations and measurements run on the disposable GitHub WSL runner.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows runner required');
const wsl = args => execFileSync('wsl', ['-e', ...args], { stdio: 'inherit', timeout: 3300000 });
const linuxPath = input => execFileSync('wsl', ['-e','wslpath','-a','-u',input], { encoding:'utf8' }).trim();
const source = linuxPath(path.resolve('native/bench/providers'));
if (process.argv[2] === 'prepare') {
  wsl(['env','GITHUB_ACTIONS=true','bash',linuxPath(path.resolve('scripts/ci/provider-benchmark-linux.sh'))]);
} else if (process.argv[2] === 'run') {
  wsl(['sh','-ec','mkdir -p /opt/provider-benchmark; cp -a "$1/." /opt/provider-benchmark/','benchmark-copy',source]);
  wsl(['env','TEXPRESSO_MIKTEX_WINDOWS_BIN='+process.env.TEXPRESSO_WINDOWS_MIKTEX_BIN,
    'sh','-c','export PATH="$HOME/bin:$HOME/.miktex/texmfs/install/miktex/bin:$PATH"; exec python3 /opt/provider-benchmark/benchmark.py --engine /opt/texpresso/build/texpresso --output /opt/provider-benchmark-output --repeats 3']);
} else if (process.argv[2] === 'collect') {
  const output = path.resolve('artifacts/provider-benchmark'); fs.mkdirSync(output,{recursive:true});
  // Collect compact reports/logs, not format caches, mirrored files or binaries.
  const list = spawnSync('wsl',['-e','sh','-ec','cd /opt/provider-benchmark-output && find . -type f \\( -name "*.json" -o -name "*.md" -o -name "*.log" \\) ! -path "*/lookup-cache/*" -print0'],{encoding:'buffer'});
  if (list.status !== 0) { console.log('Benchmark output unavailable'); process.exit(0); }
  const archive = spawnSync('wsl',['-e','tar','-C','/opt/provider-benchmark-output','--null','-T','-','-cf','-'],{input:list.stdout,maxBuffer:30*1024*1024});
  if (archive.status !== 0) throw new Error('Diagnostic collection failed');
  const extract = spawnSync('tar',['-C',output,'-xf','-'],{input:archive.stdout,stdio:['pipe','inherit','inherit']});
  if (extract.status !== 0) throw new Error('Diagnostic extraction failed');
  const report = path.join(output,'results.md');
  if (fs.existsSync(report)) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,fs.readFileSync(report,'utf8'));
} else throw new Error('Expected prepare, run or collect');
