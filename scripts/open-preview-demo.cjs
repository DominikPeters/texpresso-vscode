// Open a writable sample and the packaged extension in an isolated local profile.
// Requires a locally built headless engine and TeX Live; never downloads either.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const demo = path.join(repo, 'artifacts/preview-demo');
// Keep macOS IPC socket paths below its short Unix-domain socket limit.
const profile = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir()), 'txp-demo-'));
const binary = path.resolve(process.env.TEXPRESSO_BINARY || path.join(repo, 'native/.bundles', `${process.platform}-${process.arch}-preview/bin/texpresso`));
const cli = process.env.VSCODE_CLI || (process.platform === 'darwin' ?
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : 'code');
function run(args, env) {
  const result = spawnSync(cli, args, {encoding: 'utf8', env, timeout: 60000, shell: process.platform === 'win32'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
try {
  if (!fs.existsSync(binary)) throw new Error(`Build the local preview engine first, or set TEXPRESSO_BINARY. Missing: ${binary}`);
  const check = spawnSync(binary, ['-capabilities'], {encoding: 'utf8', timeout: 5000});
  if (check.error) throw check.error;
  if (check.status !== 0 || JSON.parse(check.stdout).previewProtocol !== 1) throw new Error('This engine does not support the embedded preview.');
  const vsix = path.join(repo, 'artifacts/texpresso.vsix');
  if (!fs.existsSync(vsix)) throw new Error('Run npm run package:vsix first.');
  fs.mkdirSync(path.join(demo, 'sample/.vscode'), {recursive: true});
  const file = path.join(demo, 'sample/embedded-preview.tex');
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(__dirname, 'preview-demo/sample.tex'), file);
  const settings = JSON.stringify({
    'texpresso.command': binary, 'texpresso.packageProvider': 'texlive', 'texpresso.previewLocation': 'editor',
    'texpresso.useChangeRangeMode': true, 'texpresso.syncTeXForwardOnSelection': false,
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern',
    'chat.disableAIFeatures': true, 'editor.fontSize': 16, 'editor.minimap.enabled': false,
    'window.zoomLevel': 0, 'telemetry.telemetryLevel': 'off'
  }, null, 2);
  fs.writeFileSync(path.join(demo, 'sample/.vscode/settings.json'), settings);
  fs.mkdirSync(path.join(profile, 'user/User'), {recursive: true});
  fs.writeFileSync(path.join(profile, 'user/User/settings.json'), settings);
  const workspace = path.join(demo, 'Preview.code-workspace');
  fs.writeFileSync(workspace, JSON.stringify({folders: [{path: 'sample'}]}));
  const env = {...process.env, PATH: (process.platform === 'darwin' ? '/Library/TeX/texbin' + path.delimiter : '') + process.env.PATH,
    TEXPRESSO_DEMO_FILE: file};
  const profiles = ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', path.join(profile, 'extensions')];
  run([...profiles, '--install-extension', vsix, '--force'], env);
  const child = spawn(cli, ['--new-window', ...profiles, '--extensionDevelopmentPath', path.join(__dirname, 'preview-demo'),
    '--disable-extension', 'github.copilot-chat', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace],
    {env, stdio: 'inherit', shell: process.platform === 'win32'});
  child.on('error', error => {console.error(error.message); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code || 0;});
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
