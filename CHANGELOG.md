# Release notes

### 2.0.0 (release candidate)

- Select TeX Live (default) or Tectonic as the package provider.
- Select a bundled native engine automatically in platform-specific VSIXs; retain explicit external-engine overrides and PATH fallback in the universal package.
- Run as a workspace extension, including directly inside Remote WSL.
- Add a live editor preview with continuous scrolling, page navigation, fit and zoom controls, a magnifier, hyperlinks, and both SyncTeX directions.
- Support sharp SVG rendering and bounded PNG rendering, incremental updates, adaptive rendering, and cached page navigation.
- Prepare nearby compiler checkpoints during idle time to reduce edit latency, and recover from unexpected engine exits while replaying unsaved buffers.
- Preserve the external viewer for older engines and explicit Window selection.
- Accept upstream's unknown SyncTeX column marker instead of dropping the navigation notification.

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
