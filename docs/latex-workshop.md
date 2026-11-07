# LaTeX Workshop compatibility

TeXpresso and LaTeX Workshop can share a project. Workshop supplies editing
features and conventional builds; TeXpresso supplies an independent preview of
the current editor buffers. Neither extension needs to be disabled.

## Checked behavior

The coexistence suite uses a real VS Code extension host, the native TeXpresso
engine, LaTeX Workshop, and a XeLaTeX recipe. It checks:

- Both extensions activate and follow the same `% !TeX root` comment from an
  included chapter.
- Workshop reference completions remain available during live preview.
- Workshop's PDF viewer and TeXpresso's webview remain open together.
- Unsaved edits reach TeXpresso without modifying Workshop's PDF or auxiliary
  files; SHA-256 snapshots check output isolation.
- Explicit forward SyncTeX commands reach their respective viewers.
- Saving triggers Workshop's default `onFileChange` automatic build and includes
  the saved edit in the external compiler's output.
- A Workshop build in a custom `build/` directory succeeds while TeXpresso is
  active. Restarting the preview and cleaning Workshop's auxiliary files leave
  live editing functional.

TeXpresso declares no default keybindings, PDF custom editor, language provider,
or formatter, and its command and setting identifiers use its own namespace.
It does not intercept Workshop's build/view/SyncTeX commands or modify Workshop
settings. The native engine buffers its generated files in memory, which avoids
competing writes to the conventional build's PDF, SyncTeX and auxiliary files.

## Choices that remain independent

- **Root selection:** both understand `% !TeX root`; TeXpresso's remembered
  selection and Workshop's automatic root discovery are separate. Use a magic
  comment when the workspace contains several main documents. There is no
  synchronization with Workshop's special `subfiles` root selection.
- **Compiler:** Workshop recipes and `% !TeX program` comments do not select
  TeXpresso's engine. A successful LuaLaTeX or pdfLaTeX build does not guarantee
  that the project works in TeXpresso's XeTeX-based live engine.
- **Build products:** Workshop's `outDir`, `auxDir`, job name and recipe
  environment are not imported by TeXpresso. Generated inputs such as `.bbl`
  files must be accessible through TeXpresso's own file search. Output-directory
  coexistence does not establish bibliography interoperability for every recipe.
- **External compilation:** TeXpresso's External Compile and Refresh runs
  `texpresso.externalCompileCommand` (default `latexmk`), not Workshop's selected
  recipe. After building with Workshop, restart TeXpresso if it needs to reload
  generated inputs.
- **Navigation:** Workshop shortcuts continue to target its PDF. TeXpresso's
  automatic cursor following and explicit SyncTeX command target its live
  preview. Each viewer handles inverse search independently.
- **Automatic builds:** Workshop normally builds after saved input changes;
  TeXpresso updates unsaved buffers. Both can run together. Users who prefer
  manual final builds can set `latex-workshop.latex.autoBuild.run` to `never`;
  TeXpresso does not change this preference automatically.

The official Workshop documentation describes its
[automatic builds and recipes](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile),
[root discovery](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile#multi-files-projects),
and [PDF viewer and SyncTeX](https://github.com/James-Yu/LaTeX-Workshop/wiki/View).

## Reproducing the check

Use `npm run test:integration:latex-workshop` with the three environment variables
described in [the development guide](development.md). The runner reuses an
installed Workshop directory and native engine in an isolated profile, with no
extension download or native build.

Review environment: macOS arm64, VS Code 1.145.0, LaTeX Workshop 10.20.0,
TeXpresso extension 2.0.0 and the existing local native preview bundle.
This is a desktop coexistence check, not a joint Windows/WSL or remote-host
certification. Inverse-search clicks, custom user keymaps, arbitrary build
recipes, bibliography tools, and all Workshop editing features are not covered
by this suite. The existing native and webview suites cover TeXpresso's own
inverse SyncTeX behavior separately.
