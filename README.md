# TeXpresso VS Code Extension
Visual Studio Code extension for interacting with [TeXpresso](https://github.com/let-def/texpresso/), which provides a "live rendering" experience when editing LaTeX documents. TeXpresso needs to be installed separately to use this extension, following its [install guide](https://github.com/let-def/texpresso/blob/main/INSTALL.md) which contains instructions for macOS, Fedora, Arch Linux, Debian, and Ubuntu.

![ezgif-6-3b2ad402f4](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/0ff5cf57-5a2e-48cd-9e5f-633a5ed44411)

To use this extension, open the `.tex` document you wish to edit, then open the command pallete (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>), and select `TeXpresso: Start Document`. A separate window will open showing the compiled preview. The preview immediately updates when you edit the file in VS Code, and using SyncTeX the preview automatically jumps to the current code position (and vice versa for clicks in the preview window). Buttons at the top of the editor are provided to switch pages, and a compile log for seeing compilation errors can be found by using the Output panel.

## Features

To change pages, use the buttons:
![recording10](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/2dbfb081-409e-4f31-b3af-e64cea25414b)

Use SyncTeX (forwards - editor to preview):
![recording11](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/80824192-f9e9-4f71-9959-df5ed7d5d617)

Use SyncTeX (backwards - preview to editor):
![recording12](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/4a9c7709-275f-48d5-b6f9-dcaeede0c622)

## Requirements

TeXpresso must be installed, and must be callable at the path provided in the `texpresso.command` setting.

## Extension Settings

This extension contributes the following settings:

* `texpresso.command`: The path to the texpresso binary.
* `texpresso.syncTeXForwardOnSelection`: Controls whether the preview should be updated when the selection in the editor changes.
* `texpresso.useEditorTheme`: Controls whether the preview should use the same color theme as the editor.

## Architecture

TeXpresso and the underlying LaTeX compilers are based on a UTF-8 byte representation, and [communication between the editor and TeXpresso](https://github.com/let-def/texpresso/blob/main/EDITOR-PROTOCOL.md) occurs in terms of byte offsets. However, VS Code only provides access to character positions and not their byte position. Thus, this extension keeps a copy of the current document in a *rope* data structure ([wikipedia](https://en.wikipedia.org/wiki/Rope_(data_structure))), enriched with byte offsets. This allows for efficient conversion between character and byte positions, and also allows for efficient edits to the underlying text string. The [code for the rope data structure](https://github.com/DominikPeters/texpresso-vscode/blob/master/src/rope.ts) builds on https://github.com/component/rope.

## Known Issues

The extension does not yet react instantaenously to changes to files that are included using commands like `\input`.

Loses connection if the filename of the main document is changed.

## Release Notes

### 1.0.0

Initial release of the extension.
