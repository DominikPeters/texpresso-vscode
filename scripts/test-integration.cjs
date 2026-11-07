const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const bundled = process.argv.includes('--bundled');
  const packaged = process.argv.includes('--packaged') || bundled;
  const vsixIndex = process.argv.indexOf('--vsix');
  if (vsixIndex >= 0 && !process.argv[vsixIndex + 1]) { throw new Error('--vsix requires a file path'); }
  const vsix = path.resolve(vsixIndex >= 0 ? process.argv[vsixIndex + 1] : 'artifacts/texpresso.vsix');
  const profileVaried = process.argv.includes('--profile-varied');
  const realistic = process.argv.includes('--profile-realistic');
  const svgPatch = process.argv.includes('--profile-svg-patch');
  const coexistence = process.argv.includes('--latex-workshop');
  const workshop = process.env.TEXPRESSO_TEST_LATEX_WORKSHOP;
  if (coexistence && !workshop) { throw new Error('--latex-workshop requires TEXPRESSO_TEST_LATEX_WORKSHOP (an installed extension directory)'); }
  const profileAuto = process.argv.includes('--profile-auto') || profileVaried || realistic || svgPatch;
  const preview = process.argv.includes('--preview') || profileAuto || bundled || coexistence;
  const realEngine = process.argv.includes('--real-engine') || preview;
  const useWSL = realEngine && process.platform === 'win32';
  const binary = process.env.TEXPRESSO_BINARY;
  if (realEngine && !binary && !bundled) { throw new Error('--real-engine requires TEXPRESSO_BINARY (a Linux path when using WSL)'); }
  if (bundled && useWSL) { throw new Error('Run bundled-engine acceptance inside a Linux/Remote WSL extension host'); }
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
    'texpresso.command': bundled ? '' : realEngine ? (useWSL && !preview ? 'env' : binary) : process.execPath,
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
    ...(preview ? { 'window.newWindowDimensions': 'maximized' } : {}),
    'editor.fontSize': 16,
    'telemetry.telemetryLevel': 'off'
  }));
  // Start in workspace mode: converting a folder window to a multi-root
  // workspace reloads the extension host on VS Code 1.88, aborting the suite.
  const workspaceFile = path.join(root, 'fixture.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspace }] }));
  let failed = true;
  try {
    let executable = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    // test-electron 2.5 still returns Electron for macOS; newer VS Code
    // distributions name the executable Code. Retain support for older builds.
    if (process.platform === 'darwin' && !fs.existsSync(executable)) {
      const renamed = path.join(path.dirname(executable), 'Code');
      if (fs.existsSync(renamed)) { executable = renamed; }
    }
    const profiles = ['--user-data-dir=' + path.join(root, 'user'), '--extensions-dir=' + path.join(root, 'extensions')];
    if (coexistence) {
      // Reuse an installed copy without changing the user's extension profile
      // or duplicating its dependencies on disk.
      const manifest = JSON.parse(fs.readFileSync(path.join(workshop, 'package.json'), 'utf8'));
      if (manifest.publisher !== 'James-Yu' || manifest.name !== 'latex-workshop') { throw new Error('Expected the LaTeX Workshop extension'); }
      fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
      fs.symlinkSync(path.resolve(workshop), path.join(root, 'extensions', 'james-yu.latex-workshop-' + manifest.version), process.platform === 'win32' ? 'junction' : 'dir');
    }
    let development = path.resolve(__dirname, '..');
    if (packaged) {
      const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
      const result = spawnSync(cli, [...cliArgs, '--install-extension', vsix, '--force', ...profiles],
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
      extensionTestsPath: path.resolve(__dirname, '../out/test/integration/' + (svgPatch ? 'svg-patch-profile.js' : realistic ? 'realistic-profile.js' : coexistence ? 'latex-workshop.js' : profileVaried ? 'varied-profile.js' : profileAuto ? 'auto-profile.js' : preview ? 'preview.js' : realEngine ? 'real-engine.js' : 'index.js')),
      extensionTestsEnv: {
        TEXPRESSO_PROFILE: profileVaried ? '1' : process.env.TEXPRESSO_PROFILE,
        TEXPRESSO_TEST_WEBVIEW_ONLY: process.env.TEXPRESSO_TEST_WEBVIEW_ONLY,
        TEXPRESSO_TEST_PACKAGED: packaged ? '1' : undefined,
        TEXPRESSO_TEST_BUNDLED: bundled ? '1' : undefined,
        TEXPRESSO_TEST_TRACE: path.join(root, 'engine.jsonl'),
        TEXPRESSO_TEST_NODE: process.execPath,
        TEXPRESSO_TEST_ENGINE: fixture,
        TEXPRESSO_BINARY: binary,
        TEXPRESSO_TEST_LOGS: path.join(root, 'user/logs'),
        TEXPRESSO_CAPTURE_DIR: process.env.TEXPRESSO_CAPTURE_DIR,
        TEXPRESSO_PROFILE_INPUT_LIMIT: process.env.TEXPRESSO_PROFILE_INPUT_LIMIT,
        TEXPRESSO_PROFILE_PHASES: process.env.TEXPRESSO_PROFILE_PHASES,
        TEXPRESSO_PROFILE_LEGACY_FOLLOW: process.env.TEXPRESSO_PROFILE_LEGACY_FOLLOW,
        TEXPRESSO_PROFILE_RICH: process.env.TEXPRESSO_PROFILE_RICH,
        TEXPRESSO_PROFILE_PREWARM_MODES: process.env.TEXPRESSO_PROFILE_PREWARM_MODES,
        TEXPRESSO_PROFILE_AUTORERUN: process.env.TEXPRESSO_PROFILE_AUTORERUN,
        TEXPRESSO_PROFILE_RAPID_EARLY: process.env.TEXPRESSO_PROFILE_RAPID_EARLY,
        TEXPRESSO_PROFILE_SCENARIO: process.env.TEXPRESSO_PROFILE_SCENARIO,
        TEXPRESSO_PROFILE_OUTPUT: process.env.TEXPRESSO_PROFILE_OUTPUT,
        TEXPRESSO_SVG_PATCH_CAPTURE: process.env.TEXPRESSO_SVG_PATCH_CAPTURE,
        TEXPRESSO_SVG_PATCH_BASELINE: process.env.TEXPRESSO_SVG_PATCH_BASELINE,
        TEXPRESSO_PROFILE_FEATURES: process.env.TEXPRESSO_PROFILE_FEATURES,
        TEXPRESSO_REAL_CASES: process.env.TEXPRESSO_REAL_CASES,
        TEXPRESSO_REAL_WIDTHS: process.env.TEXPRESSO_REAL_WIDTHS,
        TEXPRESSO_REAL_REPEATS: process.env.TEXPRESSO_REAL_REPEATS,
        TEXPRESSO_REAL_DPR: process.env.TEXPRESSO_REAL_DPR,
        TEXPRESSO_REAL_CAPTURE: process.env.TEXPRESSO_REAL_CAPTURE,
        TEXPRESSO_PROFILE_RESUME: process.env.TEXPRESSO_PROFILE_RESUME,
        TEXPRESSO_PROFILE_PAGES: process.env.TEXPRESSO_PROFILE_PAGES,
        TEXPRESSO_PROFILE_KINDS: process.env.TEXPRESSO_PROFILE_KINDS,
        TEXPRESSO_PROFILE_REPEATS: process.env.TEXPRESSO_PROFILE_REPEATS,
        TEXPRESSO_PROFILE_COORDINATE_PREWARM: process.env.TEXPRESSO_PROFILE_COORDINATE_PREWARM,
        TEXPRESSO_PROFILE_VARIANTS: process.env.TEXPRESSO_PROFILE_VARIANTS,
        TEXPRESSO_PROFILE_EXTRAS: process.env.TEXPRESSO_PROFILE_EXTRAS,
        TEXPRESSO_PROFILE_CODECS: process.env.TEXPRESSO_PROFILE_CODECS
      },
      // Preview checks use animation frames; background/occlusion throttling
      // must not suspend their assertions or distort scheduled typing.
      // https://www.electronjs.org/docs/latest/api/command-line-switches
      // https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md
      launchArgs: [workspaceFile, ...(preview ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] : []), ...(packaged || coexistence ? [] : ['--disable-extensions']), '--disable-extension=github.copilot-chat', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', ...profiles,
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        ...(realistic && process.env.TEXPRESSO_REAL_DPR ? ['--force-device-scale-factor=' + Number(process.env.TEXPRESSO_REAL_DPR)] : []),
        ...(process.env.TEXPRESSO_DEBUG_PORT ? ['--remote-debugging-port=' + process.env.TEXPRESSO_DEBUG_PORT] : [])]
    });
    failed = false;
  } finally {
    if (failed) {
      const diagnostics = path.resolve(process.env.TEXPRESSO_TEST_ARTIFACTS || 'artifacts', coexistence ? 'latex-workshop-host' : realEngine ? 'real-engine-host' : packaged ? 'packaged-host' : 'development-host');
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
