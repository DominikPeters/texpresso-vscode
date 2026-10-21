# TeXpresso VS Code Extension
Visual Studio Code extension for interacting with [TeXpresso](https://github.com/let-def/texpresso/), which provides a "live rendering" experience when editing LaTeX documents. TeXpresso needs to be installed separately to use this extension, following its [install guide](https://github.com/let-def/texpresso/blob/main/INSTALL.md) which contains instructions for macOS, Fedora, Arch Linux, Debian, and Ubuntu. The extension can be used simultaneously with other LaTeX extensions such as [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop).

![ezgif-6-3b2ad402f4](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/0ff5cf57-5a2e-48cd-9e5f-633a5ed44411)

After installing the extension, you need to configure the path to the TeXpresso binary in the settings.

To use this extension, open the `.tex` document you wish to edit, then open the command pallete (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>), and select `TeXpresso: Start Document`. A separate window will open showing the compiled preview. The preview immediately updates when you edit the file in VS Code, and using SyncTeX the preview automatically jumps to the current code position (and vice versa for clicks in the preview window). Buttons at the top of the editor are provided to switch pages, and a compile log for seeing compilation errors can be found by using the Output panel.

The TeXpresso status-bar entry opens preview controls: Rerun Once, Automatic Reruns, Pause/Resume, Start, Stop, Restart, Check Setup, logs, and Settings. It shows the main document while running and indicates startup, pause, or failure. Start and Stop are also available in the editor toolbar. Stop can cancel a preview that is still starting; Restart keeps the same main document when you are editing an included file.

### Troubleshooting

Run **TeXpresso: Check Setup** from the Command Palette or preview controls. The **TeXpresso Setup** Output channel shows the extension host, main document, execution mode, package provider, executable lookup, and exact launch arguments. It also checks for `kpsewhich` and `tectonic` on the host (or inside WSL).

Launch errors offer **Check Setup**, **Open Settings**, and **Show Engine Log**. The **TeXpresso Engine** channel contains process diagnostics, while **TeXpresso** and **TeXpresso Log** contain compiler output. Logs remain available after the preview exits. An engine crash or unsupported option is reported separately from an executable that cannot be found.

### Synchronization and refresh

With automatic SyncTeX enabled, the preview synchronizes to the active cursor after compilation, including the first compilation and recovery from a temporary syntax error. Source line numbers are translated between VS Code and SyncTeX conventions.

Renaming a tracked source file or its containing folder through VS Code restarts the preview with the current main-document path. Included files found through configured `-I` directories are matched to their editor buffers, including paths containing spaces and buffers opened through directory symlinks.

**Refresh** and a successful **External Compile and Refresh** restart the engine. A plain upstream `rescan` can miss auxiliary files that did not exist at startup, leaving references unresolved. Restarting clears that cache and automatic SyncTeX restores the active source position. It also resets manual preview navigation and zoom. External compilation saves dirty tracked source buffers first.

With `texpresso.watchDependencies` enabled (the default), project files used by TeXpresso are watched for changes on disk. Recent engines report file lookups, allowing images and other resources to be tracked alongside TeX sources. Older engines still provide source-file tracking. Changes are batched into a rescan; creating a previously missing dependency or deleting an input restarts the preview to clear the engine's cached filesystem state. Editor buffers take precedence over disk updates, and engine-written files are excluded to avoid refresh loops.

### Reruns, pause, and streaming

Recent upstream builds support **Rerun Once** and **Automatic Reruns** in the preview controls and Command Palette. Enable `texpresso.autoRerun` to run additional passes for references and the table of contents when editing pauses. This setting takes effect immediately and keeps the preview window open. Bibliography programs still run through **External Compile and Refresh**.

**Pause Preview** suspends compilation while you edit; **Resume Preview** applies the accumulated changes. The status bar indicates when the preview is paused.

Enable `texpresso.streamFiles` for editor-managed file transfer. TeXpresso starts paused; the extension registers and supplies open buffers, then resumes it and supplies discovered project resources, including binary data. The extension also updates streamed resources when they change on disk. A changed streamed image currently restarts the preview to clear upstream's cached image dimensions. Use this setting instead of putting `-stream` in additional arguments.

Automatic reruns require the merged July 2026 `rerun` support. Pause/resume and streaming require the merged May 2026 protocol additions. These features are tested against upstream [e8df770](https://github.com/let-def/texpresso/commit/e8df7709077b2f86f6e16e6c86ceefb86de06f8d). Automatic reruns and streaming default to off; if an older engine rejects a control, the extension reports it and disables that control for the session.

## Features

To change pages, use the buttons:
![recording10](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/2dbfb081-409e-4f31-b3af-e64cea25414b)

Use SyncTeX (forwards - editor to preview):
![recording11](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/80824192-f9e9-4f71-9959-df5ed7d5d617)

Use SyncTeX (backwards - preview to editor):
![recording12](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/4a9c7709-275f-48d5-b6f9-dcaeede0c622)

Use theme colors in preview (if the `useEditorTheme` setting is activated):
<img src="https://github.com/DominikPeters/texpresso-vscode/assets/3543224/8b09d947-82cc-418b-a4d0-a0b66f75dd49" width="800">

## Requirements

TeXpresso must be installed, and must be callable at the path provided in the `texpresso.command` setting.

## Using UTF-16 version of TeXpresso for more robust performance

If you use TeXpresso version v0.1 or newer, you can use its new `change-range` feature, which allows the extension to work more efficiently and more robustly (the file is less likely to go out of sync with the preview). To use this, you need to enable the `texpresso.useChangeRangeMode` setting. 

## Extension Settings

This extension contributes the following settings:

* `texpresso.command`: The path to the texpresso binary, or a command available on PATH.
* `texpresso.packageProvider`: Select Automatic, TeX Live, or Tectonic as the package provider (TeXpresso v0.2 or newer).
* `texpresso.includeDirectories`: Additional include directories, relative to the main document or absolute.
* `texpresso.arguments`: Additional command-line arguments, with one argument per array item.
* `texpresso.autoRerun`: Run additional passes for references and the table of contents after editing pauses. Defaults to off and can be toggled from preview controls.
* `texpresso.watchDependencies`: Refresh when project dependencies change on disk. Defaults to on.
* `texpresso.streamFiles`: Supply project files through the editor protocol, including binary resources. Defaults to off.
* `texpresso.useWSL`: Controls whether to run TeXpresso within Windows Subsystem for Linux (WSL).
* `texpresso.syncTeXForwardOnSelection`: Controls whether the preview should be updated when the selection in the editor changes.
* `texpresso.useEditorTheme`: Controls whether the preview should use the same color theme as the editor.
* `texpresso.useChangeRangeMode`: Use the newer change-range command (line/character based) instead of change command (byte based). Requires TeXpresso version v0.1 or newer. When enabled, improves performance by eliminating the need for internal byte-to-character conversion.

### Package providers and additional arguments

Select a package provider in Settings by searching for `texpresso.packageProvider`. This chooses where TeXpresso loads packages; it does not install TeX Live or Tectonic or select a different TeX engine.

For example, to use Tectonic and search a project build directory:

```json
{
  "texpresso.packageProvider": "tectonic",
  "texpresso.includeDirectories": ["build"],
  "texpresso.arguments": []
}
```

Existing `-tectonic` or `-texlive` entries in `texpresso.arguments` continue to work with the Automatic provider setting. An explicit provider selection overrides those flags. Paths containing spaces remain a single array item; do not add shell quotes. For example, `["-I", "/path/to/support files"]` is valid. In additional arguments, WSL paths must use Linux syntax; the dedicated include directory setting can also convert Windows paths.

Launch settings are read for the main document on each start. The extension offers to restart a running preview when those settings change.

### Main document selection

Start Preview follows `% !TeX root = ../main.tex` comments, with relative paths resolved from the file containing the comment. Chained comments are supported; circular references and missing targets produce an error. Quoted paths containing spaces are accepted.

When editing a known input of the current preview, Start keeps that preview’s main document. A standalone file containing `\documentclass` or `\begin{document}` is used directly. Otherwise a picker lists standalone TeX files in the current workspace folder, with relative paths to distinguish duplicate filenames. Browse and Use Current File are also available.

Use **TeXpresso: Select Main Document** from the Command Palette or preview controls to choose explicitly. The choice is remembered for that workspace folder and follows VS Code file/folder renames. Selecting a different main document replaces an existing preview; with no preview running, it chooses the document for the next start. Each folder in a multi-root workspace has its own selection and launch settings. The extension does not infer include relationships by parsing the whole project.

Stop and extension deactivation wait for shutdown. On Linux and macOS, the extension owns a process group and terminates its helper processes too, escalating after a short grace period if necessary. Native Windows launches use process-tree termination.

### Windows and WSL

When VS Code runs on Windows and launches TeXpresso inside WSL, enable `texpresso.useWSL` and use the Linux executable path. When the extension itself runs inside a Remote WSL window, leave `texpresso.useWSL` disabled and configure it like a Linux installation.

## Architecture

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

Run `npm run test:package` to build and inspect a VSIX, install it into an isolated extension directory, and run the same host suite against the installed extension. This needs the `vsce` CLI; CI pins `@vscode/vsce` to 3.7.1. The production bundle includes its JavaScript dependencies, so the VSIX contains only the manifest, runtime bundle, icon, README, and license. The resulting VSIX is saved under `artifacts/`.

Set `VSCODE_EXECUTABLE` to an existing VS Code executable to avoid downloading a test copy, or `VSCODE_VERSION` to test a particular version (default: stable). Linux host tests need a display, for example `xvfb-run -a npm run test:integration`. Failed host runs retain logs, the engine trace, and their synthetic workspace under `artifacts/`; `TEXPRESSO_TEST_ARTIFACTS` overrides that location. CI uploads diagnostics on failure and cancels superseded runs.

For tests against an actual TeXpresso build, set `TEXPRESSO_BINARY` to its absolute path and run `npm run test:engine`. These use **TeX Live only by default** and test byte/range edits, filesystem/stream modes, reference convergence, pause/resume, and image updates. Set `TEXPRESSO_TEST_TECTONIC=1` to opt into Tectonic cases, which may download TeX packages. Native tests are skipped when `TEXPRESSO_BINARY` is unset. On machines without a display, set `SDL_VIDEODRIVER=dummy`; set `TEXPRESSO_TEST_ARTIFACTS` to retain native-engine diagnostics on failure. A separate Linux CI job builds upstream commit `e8df7709077b2f86f6e16e6c86ceefb86de06f8d` and runs the TeX Live cases.

Run `npm run test:integration:engine` with `TEXPRESSO_BINARY` set to test real compilation through the extension inside VS Code. On Windows, this launches the binary in the default WSL distribution, so provide its **Linux path**. CI installs Ubuntu 24.04 in WSL 2, builds the pinned TeXpresso revision with TeX Live, and runs Windows VS Code against it. The suite checks magic-root and include-directory paths containing spaces and Unicode, unsaved edits with both byte and range protocols, disk dependency refresh, streaming, restart, and termination of Linux engine/worker processes. The same suite can run against a native engine on Linux/macOS. It selects SDL's dummy video driver, as upstream's own test targets do; visible-window rendering and theme integration still need separate checks.

The WSL job caches an exported Ubuntu distribution containing TeX Live and the native build dependencies. Its key covers the workflow, `scripts/ci/wsl-environment.cjs`, and `scripts/ci/wsl-packages.txt`; changing any of these prepares a fresh image. The image is saved before source checkout copies and builds, so test failures do not discard a prepared environment and the pinned engine is rebuilt each run. The job summary records setup/import/export timings and archive size; cache download/upload timings appear in the cache steps.

## Release Notes

### 1.9.0

- Support automatic and one-shot reruns, pause/resume, and streaming with registered buffers and binary resources.
- Watch project dependencies using upstream file-lookup notifications, with source tracking on older engines.
- Add preview status and controls, Restart, Check Setup, and actionable process errors.
- Fix legacy Unicode edit offsets, forward SyncTeX line numbers, initial synchronization, and synchronization after compilation.
- Restart previews after source renames and external compilation, including newly created auxiliary files.
- Resolve included editor buffers through include directories and symlinks while retaining engine filenames.
- Add cross-platform CI, VS Code host integration tests, and optional tests against a real TeXpresso build.

### 1.8.0

Track imported files (e.g. using `\input`) in the extension and transmit changes to TeXpresso. Requires TeXpresso version v0.1 or newer (versions with support for the `input-file` command).

Fix logging output when using the lines mode.

### 1.7.0

Add support for the `change-range` command in TeXpresso. Fix WSL paths for external compile feature.

### 1.6.0

Add External Compile feature.

### 1.5.1

Fixes testing of TeXpresso command on WSL.

### 1.4.0

Add support for executing TeXpresso on WSL (Windows Subsystem for Linux).

### 1.3.0

Add a button for toggling automatic SyncTeX forward when the selection changes.

Turn off the extension when the TeXpresso window is closed.

### 1.2.0

Added support for color themes.

### 1.1.0

Changed settings identifiers.

### 1.0.0

Initial release of the extension.
