# TeXpresso VS Code Extension
Visual Studio Code extension for interacting with [TeXpresso](https://github.com/let-def/texpresso/), which provides a "live rendering" experience when editing LaTeX documents. TeXpresso needs to be installed separately to use this extension, following its [install guide](https://github.com/let-def/texpresso/blob/main/INSTALL.md) which contains instructions for macOS, Fedora, Arch Linux, Debian, and Ubuntu. The extension can be used simultaneously with other LaTeX extensions such as [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop).

![ezgif-6-3b2ad402f4](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/0ff5cf57-5a2e-48cd-9e5f-633a5ed44411)

After installing the extension, you need to configure the path to the TeXpresso binary in the settings.

To use this extension, open the `.tex` document you wish to edit, then open the command pallete (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>), and select `TeXpresso: Start Document`. A separate window will open showing the compiled preview. The preview immediately updates when you edit the file in VS Code, and using SyncTeX the preview automatically jumps to the current code position (and vice versa for clicks in the preview window). Buttons at the top of the editor are provided to switch pages, and a compile log for seeing compilation errors can be found by using the Output panel.

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

### Windows and WSL

When VS Code runs on Windows and launches TeXpresso inside WSL, enable `texpresso.useWSL` and use the Linux executable path. When the extension itself runs inside a Remote WSL window, leave `texpresso.useWSL` disabled and configure it like a Linux installation.

## Architecture

`extension.ts` connects VS Code commands and editor events to one active `TexpressoSession`. Each session owns its process, document synchronization state, and output buffers, so a previous process cannot reset a newer session.

- `configuration.ts` resolves settings for the main document and constructs launch arguments.
- `paths.ts` translates between editor paths and engine paths, including WSL.
- `engine-process.ts` handles process startup, shutdown, errors, and UTF-8-safe protocol framing.
- `protocol.ts` validates incoming messages and defines outgoing commands.
- `document-sync.ts` synchronizes the main document and imported files. Range mode sends UTF-16 edits directly; legacy mode maintains a pre-edit rope for byte offsets.
- `logs.ts` applies output appends and truncations as TeXpresso backtracks.

Compiler output, compiler logs, process diagnostics, and external builds have separate Output channels. Logs remain available after a session stops or fails.

Current upstream TeXpresso does not expose a reliable version or capability query. Newer features must not be inferred from an unreported version; capability negotiation is deferred until upstream supports it.

### Development checks

Run `npm test` to type-check, bundle, lint, and run the Node regression tests. `npm run test:unit` runs the type-checked tests without launching VS Code. Use the Extension Development Host to check editor and theme integration manually.

## Known Issues

Loses connection if the filename of the main document is changed.

## Release Notes

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
