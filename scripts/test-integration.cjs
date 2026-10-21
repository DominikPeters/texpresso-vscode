const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  // macOS Unix-domain sockets have a short path limit; keep the profile nearby.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'txp-')));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  const fixture = path.resolve(__dirname, '../src/test/fixtures/engine.cjs');
  const builder = path.resolve(__dirname, '../src/test/fixtures/build.cjs');
  const quote = value => process.platform === 'win32' ? '"' + value + '"' : "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'texpresso.command': process.execPath,
    'texpresso.arguments': [fixture],
    'texpresso.useChangeRangeMode': true,
    'texpresso.externalCompileCommand': quote(process.execPath) + ' ' + quote(builder),
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.colorTheme': 'Default Dark Modern',
    'window.zoomLevel': 0,
    'editor.fontSize': 16,
    'telemetry.telemetryLevel': 'off'
  }));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../out/test/integration/index.js'),
      extensionTestsEnv: {
        TEXPRESSO_TEST_TRACE: path.join(root, 'engine.jsonl'),
        TEXPRESSO_TEST_NODE: process.execPath,
        TEXPRESSO_TEST_ENGINE: fixture,
        TEXPRESSO_CAPTURE_DIR: process.env.TEXPRESSO_CAPTURE_DIR
      },
      launchArgs: [workspace, '--disable-extensions', '--disable-extension=github.copilot-chat', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir=' + path.join(root, 'user'),
        '--extensions-dir=' + path.join(root, 'extensions'),
        ...(process.env.TEXPRESSO_DEBUG_PORT ? ['--remote-debugging-port=' + process.env.TEXPRESSO_DEBUG_PORT] : [])]
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
