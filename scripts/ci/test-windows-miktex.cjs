// Native Windows MiKTeX with Linux engine + files, on a disposable WSL runner.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows runner required');
const bin = process.env.TEXPRESSO_WINDOWS_MIKTEX_BIN;
if (!bin) throw new Error('Windows MiKTeX setup did not supply its binary directory');
const wsl = args => execFileSync('wsl', ['-e', ...args], { stdio: 'inherit', timeout: 1500000 });
wsl(['sh','-ec','! command -v findtexmf; test -x /opt/texpresso/build/texpresso']);
wsl(['python3','/opt/texpresso/test/test-miktex-windows-cancel.py',path.join(process.env.RUNNER_TEMP,'TeXpresso bridge fixture')]);
wsl(['env', 'TEXPRESSO_MIKTEX_WINDOWS_BIN='+bin, 'TEXPRESSO_TEST_MIKTEX_PROVIDER=miktex-windows',
  'TEXPRESSO_TEST_ARTIFACTS=/opt/texpresso/windows-miktex-diagnostics', 'python3',
  '/opt/texpresso/test/test-miktex-real.py', '/opt/texpresso/build/texpresso']);
execFileSync(path.join(bin,'findtexmf.exe'), ['--file-type=tex','--','csquotes.sty'], { stdio: 'inherit' });
