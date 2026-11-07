# TeXpresso for Visual Studio Code

Edit LaTeX with a live preview beside your source. TeXpresso updates the preview as you type and supports navigation in both directions with SyncTeX. It can be used alongside other LaTeX extensions, including [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop).

  ![TeXpresso live preview](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/0ff5cf57-5a2e-48cd-9e5f-633a5ed44411)

## Getting started

1. Install the extension and a TeX package provider, such as TeX Live or Tectonic, on the machine where the extension runs. For Tectonic, select it in `texpresso.packageProvider`.
2. Open a LaTeX document in VS Code.
3. Open the Command Palette and run **TeXpresso: Start Document**. The preview opens beside your source and updates as you edit.

Platform-specific packages for macOS and Linux include the TeXpresso engine. Linux bundles require glibc 2.28 or newer. The universal package requires a [separately installed engine](https://github.com/let-def/texpresso/blob/main/INSTALL.md). Leave `texpresso.command` empty to use the bundled engine when available, or set it to an executable to use your own. Older engines may open a separate native window instead of an editor preview.

For projects with multiple files, add a `% !TeX root = ../main.tex` comment or use **TeXpresso: Select Main Document**. The extension remembers your selection for the workspace folder.

## Preview controls

Use the preview toolbar to navigate pages, adjust zoom and fit, pause or restart compilation, and open compiler output. Pinch or use Control/Command-scroll to zoom. Hyperlinks are clickable; Control-click (Command-click on macOS) in the preview to jump to the corresponding source. Forward SyncTeX can follow your editor cursor quietly. Explicit forward jumps briefly highlight matching text in yellow when supported by the engine.

The magnifier button, or **M** while the preview has focus, enables a loupe: hold the left mouse button over the page to use it, and press Escape to leave magnifier mode. The preview uses Auto by default; choose PNG or SVG with `texpresso.renderingFormat` in Settings. Availability of some controls depends on the engine version.

The TeXpresso status-bar entry opens controls for starting, stopping, restarting and pausing the preview, running additional compilation passes, opening logs and changing settings. Use **External Compile and Refresh** when you need an external build, for example to run a bibliography program.

When TikZ Editor is installed locally, hover over a TikZ figure to show **Edit in TikZ Editor**. The action opens the matching source figure after saving any unsaved changes with your approval. This integration is available in trusted local desktop workspaces; use `texpresso.tikzEditorPath` if automatic detection misses the app.

## Using LaTeX Workshop

Keep LaTeX Workshop for completions, citations, builds and its PDF viewer, and use **TeXpresso: Start Document** for live preview. The previews are independent: Workshop's build, view and SyncTeX shortcuts still operate on its PDF. Use **TeXpresso: Show Current Position in Preview Window (SyncTeX)** for an explicit jump in the live preview. A `% !TeX root = main.tex` comment gives both extensions the same main document.

TeXpresso uses its own engine and settings; it does not inherit Workshop recipes, compiler choices or output directories. **External Compile and Refresh** uses `texpresso.externalCompileCommand`, rather than the selected Workshop recipe. Workshop's automatic builds can stay enabled. To avoid running an extra build on each save, optionally set `latex-workshop.latex.autoBuild.run` to `never` and build manually when needed.

## Windows and WSL

For Windows, we recommend opening your project in a [WSL](https://code.visualstudio.com/docs/remote/wsl) window. Run **TeXpresso: Reopen Folder in WSL**, install the extension in that window, and install TeX Live or Tectonic in the Linux distribution. The Linux engine runs in WSL while the preview appears in VS Code on Windows.

Alternatively, from a local Windows window, enable `texpresso.useWSL` to use a separately installed engine in WSL. Set `texpresso.wslDistribution` if you do not want the default distribution, and set `texpresso.command` to the Linux executable path or leave it empty to find `texpresso` on the distribution's PATH.

## Settings

Search for **TeXpresso** in VS Code Settings. Common options include:

- `texpresso.command`: choose an external engine.
- `texpresso.previewLocation`: choose Auto, Editor or Window.
- `texpresso.renderingFormat`: choose Auto (the default), PNG or SVG for the editor preview.
- `texpresso.packageProvider`: choose TeX Live (the default) or Tectonic.
- `texpresso.includeDirectories`: add directories for project inputs.
- `texpresso.autoRerun`: run additional passes for references and the table of contents when editing pauses.
- `texpresso.watchDependencies`: refresh when project files change on disk.
- `texpresso.syncTeXForwardOnSelection`: follow the source cursor in the preview.
- `texpresso.useEditorTheme`: use editor theme colors in the preview.

## Troubleshooting

Run **TeXpresso: Check Setup** to inspect the selected engine, package provider and launch settings. If compilation fails, open the **TeXpresso** and **TeXpresso Log** output channels; **TeXpresso Engine** contains process diagnostics. Check that the package provider and required LaTeX packages are installed on the extension host, including inside WSL when applicable.

If a document uses an older external engine, select **Window** in `texpresso.previewLocation` or install a compatible platform package for the editor preview.

## Licensing and source

The extension's own code is MIT licensed. Platform packages also contain native components under AGPL, GPL, LGPL and permissive licenses; see the [third-party notices](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/THIRD-PARTY-NOTICES.txt). License texts are included with the extension. Corresponding source archives and build instructions are available under the matching version in the [release downloads](https://github.com/DominikPeters/texpresso-vscode/releases).

## Development

See the [development guide](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/docs/development.md), [native build guide](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/native/README.md), and [release notes](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/CHANGELOG.md).
