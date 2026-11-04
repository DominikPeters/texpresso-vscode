# TeXpresso for Visual Studio Code

Edit LaTeX with a live preview beside your source. TeXpresso updates the preview as you type and supports navigation in both directions with SyncTeX. It can be used alongside other LaTeX extensions, including [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop).

  ![TeXpresso live preview](https://github.com/DominikPeters/texpresso-vscode/assets/3543224/0ff5cf57-5a2e-48cd-9e5f-633a5ed44411)

## Getting started

1. Install the extension and a TeX package provider, such as TeX Live or Tectonic, on the machine where the extension runs.
2. Open a LaTeX document in VS Code.
3. Open the Command Palette and run **TeXpresso: Start Document**. The preview opens beside your source and updates as you edit.

Platform-specific packages for macOS and Linux include the TeXpresso engine. The universal package requires a [separately installed engine](https://github.com/let-def/texpresso/blob/main/INSTALL.md). Leave `texpresso.command` empty to use the bundled engine when available, or set it to an executable to use your own. Older engines may open a separate native window instead of an editor preview.

For projects with multiple files, add a `% !TeX root = ../main.tex` comment or use **TeXpresso: Select Main Document**. The extension remembers your selection for the workspace folder.

## Preview controls

Use the preview toolbar to navigate pages, adjust zoom and fit, pause or restart compilation, and open compiler output. Pinch or use Control/Command-scroll to zoom. Hyperlinks are clickable; Control-click (Command-click on macOS) in the preview to jump to the corresponding source. Forward SyncTeX can follow your editor cursor.

The magnifier button, or **M** while the preview has focus, enables a loupe: hold the left mouse button over the page to use it, and press Escape to leave magnifier mode. The toolbar also offers Auto, PNG and SVG rendering. Availability of some controls depends on the engine version.

The TeXpresso status-bar entry opens controls for starting, stopping, restarting and pausing the preview, running additional compilation passes, opening logs and changing settings. Use **External Compile and Refresh** when you need an external build, for example to run a bibliography program.

## Windows and WSL

For Windows, we recommend opening your project in a [WSL](https://code.visualstudio.com/docs/remote/wsl) window. Run **TeXpresso: Reopen Folder in WSL**, install the extension in that window, and install TeX Live or Tectonic in the Linux distribution. The Linux engine runs in WSL while the preview appears in VS Code on Windows.

Alternatively, from a local Windows window, enable `texpresso.useWSL` to use a separately installed engine in WSL. Set `texpresso.wslDistribution` if you do not want the default distribution, and set `texpresso.command` to the Linux executable path or leave it empty to find `texpresso` on the distribution's PATH.

To try an existing **Windows MiKTeX installation**, select **Windows MiKTeX from WSL (Experimental)** in `texpresso.packageProvider`. The engine still runs in WSL; packages and fonts come from Windows MiKTeX. If MiKTeX is absent from the Windows PATH, set `texpresso.miktexWindowsBin` to its Windows binary directory, such as `C:\Program Files\MiKTeX\miktex\bin\x64`. Enable `texpresso.miktexAutoInstall` if you want missing packages downloaded automatically. This works in a Remote WSL window or with the local Windows configuration above, and requires WSL Windows interoperability and Windows PowerShell.

MiKTeX support is experimental and currently substantially slower, including during editing. Select TeX Live or Tectonic in `texpresso.packageProvider` for the most responsive preview; see the [provider benchmarks](https://github.com/DominikPeters/texpresso-vscode/blob/HEAD/docs/profiling/2026-11-04-provider-cache.md).

## Settings

Search for **TeXpresso** in VS Code Settings. Common options include:

- `texpresso.command`: choose an external engine.
- `texpresso.previewLocation`: choose Auto, Editor or Window.
- `texpresso.packageProvider`: choose Automatic, TeX Live, MiKTeX or Tectonic.
- `texpresso.miktexAutoInstall`: allow MiKTeX to download missing packages without prompting (off by default; select MiKTeX explicitly).
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
