# Development

`extension.ts` connects VS Code commands and editor events to one active `TexpressoSession`. Each session owns its process, document synchronization state, and output buffers, so a previous process cannot reset a newer session.

- `configuration.ts` resolves settings for the main document and constructs launch arguments.
- `paths.ts` translates between editor paths and engine paths, including WSL, symlinks, and include-directory lookup. Logical engine filenames remain distinct from physical editor paths.
- `engine-process.ts` handles process startup, shutdown, errors, and UTF-8-safe protocol framing.
- `protocol.ts` validates incoming messages and defines outgoing commands.
- `document-sync.ts` synchronizes the main document and imported files. Range mode sends UTF-16 edits directly; legacy mode calculates byte offsets from a pre-edit text snapshot to preserve surrogate pairs.
- `dependencies.ts` handles file lookups, dependency changes, and binary resource transfer. Watchers are shared by directory and disposed with their sessions.
- `controls.ts`, `failures.ts`, and `setup.ts` provide preview controls and troubleshooting.
- `logs.ts` applies output appends and truncations as TeXpresso backtracks.

Compiler output, compiler logs, process diagnostics, and external builds have separate Output channels. Logs remain available after a session stops or fails.

Automatic reruns and streaming are explicit settings. Received lookup messages extend dependency discovery; unknown-verb replies disable rejected controls for the session.

### Development checks

Run `npm test` to type-check, bundle, lint, and run the Node regression tests. `npm run test:unit` runs the type-checked tests without launching VS Code. The regressions include main-document resolution, concurrent starts, stale session events, atomic dependency replacement, and shutdown of an unresponsive process tree.

Run `npm run test:integration` for tests inside a real VS Code Extension Development Host, with an isolated workspace and profile. The suite launches a deterministic protocol fixture as a real child process and exercises magic-root chains, multi-root settings, imported-file Unicode edits and undo, initial SyncTeX, stop/restart, file/folder renames, external compilation, and failed-startup recovery. It requires no TeXpresso installation. CI runs the suite on Linux, macOS, and Windows, plus VS Code 1.88 on Linux.

Run `npm run test:package` to build and inspect a VSIX, install it into an isolated extension directory, and run the same host suite against the installed extension. This needs the `vsce` CLI; CI installs the latest stable `@vscode/vsce` and records its version in the build log. The production bundle includes its JavaScript dependencies, so the universal VSIX contains only the manifest, runtime bundle, webview assets, icon, README, and licenses. The resulting VSIX is saved under `artifacts/`.

Set `VSCODE_EXECUTABLE` to an existing VS Code executable to avoid downloading a test copy, or `VSCODE_VERSION` to test a particular version (default: stable). Linux host tests need a display, for example `xvfb-run -a npm run test:integration`. Failed host runs retain logs, the engine trace, and their synthetic workspace under `artifacts/`; `TEXPRESSO_TEST_ARTIFACTS` overrides that location. CI uploads diagnostics on failure and cancels superseded runs.

For tests against an actual TeXpresso build, set `TEXPRESSO_BINARY` to its absolute path and run `npm run test:engine`. These use **TeX Live only by default** and test byte/range edits, filesystem/stream modes, reference convergence, pause/resume, and image updates. Set `TEXPRESSO_TEST_TECTONIC=1` to opt into Tectonic cases, which may download TeX packages. Native tests are skipped when `TEXPRESSO_BINARY` is unset. The runner uses SDL's dummy video driver to avoid opening or focusing native windows on every start/restart; set `TEXPRESSO_TEST_NATIVE_WINDOW=1` only when deliberately testing visible windows. Set `TEXPRESSO_TEST_ARTIFACTS` to retain native-engine diagnostics on failure. The Linux and WSL CI jobs build the committed `native/texpresso` submodule revision from the fork and run the TeX Live cases.

Run `npm run test:integration:engine` with `TEXPRESSO_BINARY` set to test real compilation through the extension inside VS Code. On Windows, this launches the binary in the default WSL distribution, so provide its **Linux path**. CI installs Ubuntu 24.04 in WSL 2, builds the pinned TeXpresso revision with TeX Live, and runs Windows VS Code against it. The suite checks magic-root and include-directory paths containing spaces and Unicode, unsaved edits with both byte and range protocols, disk dependency refresh, streaming, restart, and termination of Linux engine/worker processes. The same suite can run against a native engine on Linux/macOS. It selects SDL's dummy video driver, as upstream's own test targets do; visible-window rendering and theme integration still need separate checks.

The WSL job caches an exported Ubuntu distribution containing TeX Live and the native build dependencies. Its key covers `scripts/ci/wsl-environment.cjs` and `scripts/ci/wsl-packages.txt`; unrelated workflow edits reuse the image. Cold setup uses the official WSL CLI with web downloads. The image is saved before source checkout copies and builds, so test failures do not discard a prepared environment and the pinned engine is rebuilt each run. The job summary records setup/import/export timings and archive size; cache download/upload timings appear in the cache steps.

Set `TEXPRESSO_TEST_PREVIEW=1` for additional native headless tests: PNG output,
pixel limits, page demand, forward/inverse SyncTeX, stale-coordinate rejection,
and unsaved edits in filesystem/stream modes. Run
`npm run test:integration:preview` with `TEXPRESSO_BINARY` set to exercise the
actual webview, including image decoding, edits, navigation, tab restoration,
and cleanup. It also accepts a Linux binary path on Windows/WSL. Set
`VSCODE_EXECUTABLE` to an installed VS Code executable for offline testing.

Run `npm run test:integration:latex-workshop` with `TEXPRESSO_BINARY`,
`VSCODE_EXECUTABLE`, and `TEXPRESSO_TEST_LATEX_WORKSHOP` (the directory of an
installed LaTeX Workshop extension) to check coexistence. This uses a disposable
VS Code profile and links the existing Workshop installation without copying it
or changing user settings. It requires XeLaTeX on the extension host. The suite
checks both extensions together, magic-root selection, reference completions,
both viewers, unsaved edits, external output isolation, both forward SyncTeX
commands, default automatic builds, a custom output directory, and cleanup.
See the [compatibility review](latex-workshop.md) for findings and scope.

### Native engine development

The maintained engine fork is pinned as the optional `native/texpresso` submodule.
See [native build documentation](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/native/README.md) for the fork/branch workflow,
dependency locks, compact MuPDF and ICU profiles, offline macOS development
bundles, and native checks. Ordinary TypeScript development needs no native
source checkout. Platform-specific VSIXs include the tested native bundle.

Developer performance measurements and the repeatable offline suite are in
[preview profiling](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/docs/profiling/README.md).


### Deferred MiKTeX experiments

VS Code v2 exposes TeX Live and Tectonic, with TeX Live selected explicitly by
default. MiKTeX extension settings, Windows/WSL integration, catalogue/cache
prototypes and their dedicated workflow are preserved on
[`codex/miktex-experiments`](https://github.com/DominikPeters/texpresso-vscode/tree/codex/miktex-experiments).
The compact [provider measurements](profiling/2026-11-04-provider-cache.md) and
[catalogue results](profiling/2026-11-04-miktex-catalogue.md) remain here.
Shared-engine provider code and history remain unified with TeXstudio; the
extension release boundary does not require a separate engine fork.
