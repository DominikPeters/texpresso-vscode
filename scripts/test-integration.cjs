const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const preview = process.argv.includes('--preview');
  const realEngine = process.argv.includes('--real-engine') || preview;
  const useWSL = realEngine && process.platform === 'win32';
  const binary = process.env.TEXPRESSO_BINARY;
  if (realEngine && !binary) { throw new Error('--real-engine requires TEXPRESSO_BINARY (a Linux path when using WSL)'); }
  if (realEngine) { process.env.SDL_VIDEODRIVER = 'dummy'; }
  // macOS Unix-domain sockets have a short path limit; keep the profile nearby.
  // The native implementation also expands Windows 8.3 names (RUNNER~1),
  // matching the paths used by the engine's own canonicalization.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'txp-')));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  const fixture = path.resolve(__dirname, '../src/test/fixtures/engine.cjs');
  const builder = path.resolve(__dirname, '../src/test/fixtures/build.cjs');
  const quote = value => process.platform === 'win32' ? '"' + value + '"' : "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'texpresso.command': realEngine ? (useWSL && !preview ? 'env' : binary) : process.execPath,
    'texpresso.arguments': realEngine ? (useWSL && !preview ? ['SDL_VIDEODRIVER=dummy', binary] : []) : [fixture],
    'texpresso.useWSL': useWSL,
    'texpresso.packageProvider': realEngine ? 'texlive' : 'auto',
    'texpresso.useChangeRangeMode': true,
    'texpresso.previewLocation': preview ? 'editor' : 'window',
    'texpresso.externalCompileCommand': quote(process.execPath) + ' ' + quote(builder),
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.colorTheme': 'Default Dark Modern',
    'window.zoomLevel': 0,
    'editor.fontSize': 16,
    'telemetry.telemetryLevel': 'off'
  }));
  // Start in workspace mode: converting a folder window to a multi-root
  // workspace reloads the extension host on VS Code 1.88, aborting the suite.
  const workspaceFile = path.join(root, 'fixture.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspace }] }));
  let failed = true;
  const packaged = process.argv.includes('--packaged');
  try {
    let executable = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    // test-electron 2.5 still returns Electron for macOS; newer VS Code
    // distributions name the executable Code. Retain support for older builds.
    if (process.platform === 'darwin' && !fs.existsSync(executable)) {
      const renamed = path.join(path.dirname(executable), 'Code');
      if (fs.existsSync(renamed)) { executable = renamed; }
    }
    const profiles = ['--user-data-dir=' + path.join(root, 'user'), '--extensions-dir=' + path.join(root, 'extensions')];
    let development = path.resolve(__dirname, '..');
    if (packaged) {
      const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
      const result = spawnSync(cli, [...cliArgs, '--install-extension', path.resolve('artifacts/texpresso.vsix'), '--force', ...profiles],
        { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
      if (result.error) { throw result.error; }
      if (result.status !== 0) { throw new Error('VSIX installation failed: ' + result.stdout + result.stderr); }
      console.log(result.stdout);
      development = path.join(root, 'harness');
      fs.mkdirSync(development);
      fs.writeFileSync(path.join(development, 'package.json'), JSON.stringify({
        name: 'texpresso-test-harness', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.88.0' }
      }));
    }
    await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: true,
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: development,
      extensionTestsPath: path.resolve(__dirname, '../out/test/integration/' + (preview ? 'preview.js' : realEngine ? 'real-engine.js' : 'index.js')),
      extensionTestsEnv: {
        TEXPRESSO_TEST_PACKAGED: packaged ? '1' : undefined,
        TEXPRESSO_TEST_TRACE: path.join(root, 'engine.jsonl'),
        TEXPRESSO_TEST_NODE: process.execPath,
        TEXPRESSO_TEST_ENGINE: fixture,
        TEXPRESSO_BINARY: binary,
        TEXPRESSO_TEST_LOGS: path.join(root, 'user/logs'),
        TEXPRESSO_CAPTURE_DIR: process.env.TEXPRESSO_CAPTURE_DIR
      },
      launchArgs: [workspaceFile, ...(packaged ? [] : ['--disable-extensions']), '--disable-extension=github.copilot-chat', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', ...profiles,
        ...(process.env.TEXPRESSO_DEBUG_PORT ? ['--remote-debugging-port=' + process.env.TEXPRESSO_DEBUG_PORT] : [])]
    });
    failed = false;
  } finally {
    if (failed) {
      const diagnostics = path.resolve(process.env.TEXPRESSO_TEST_ARTIFACTS || 'artifacts', realEngine ? 'real-engine-host' : packaged ? 'packaged-host' : 'development-host');
      fs.mkdirSync(diagnostics, { recursive: true });
      for (const entry of ['user/logs', 'engine.jsonl', 'workspace', 'fixture.code-workspace']) {
        const source = path.join(root, entry);
        if (fs.existsSync(source)) { fs.cpSync(source, path.join(diagnostics, entry), { recursive: true }); }
      }
      console.error('Test diagnostics saved to ' + diagnostics);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
