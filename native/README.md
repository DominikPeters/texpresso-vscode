# Native engine builds

`texpresso/` is a submodule of `DominikPeters/texpresso`, on the maintained
`vscode` branch. The extension's Git commit records the exact engine commit.
The old `web-wrapper-version` branch is independent historical work; new
embedding work starts from current upstream and is implemented afresh.

The [embedded preview design](../docs/embedded-preview.md) describes a proposed
headless viewer backend, PNG/SVG export, transport, and SyncTeX/link integration.
The [offline rendering experiment](bench/README.md) records initial native and
browser measurements. The first headless PNG backend and VS Code preview are
implemented, along with outlined SVG, automatic fidelity fallbacks, and DVI
hyperlink collection. See the engine's
[preview protocol](texpresso/PREVIEW-PROTOCOL.md) for its current wire contract.

## Working with the fork

Initialize the engine only when doing native work:

```sh
git submodule update --init native/texpresso
git -C native/texpresso switch vscode
git -C native/texpresso remote add upstream https://github.com/let-def/texpresso.git
```

`submodule update` checks out the recorded commit, initially detached. If a
local `vscode` branch does not exist, create it from `origin/vscode`. Add the
`upstream` remote only once. Ordinary extension tests do not need a submodule
checkout or native build dependencies.

Maintain the fork's `main` as an upstream mirror and merge selected upstream
updates into `vscode`. Preserve published `vscode` commits: extension releases
refer to those SHAs. Use feature branches for engine changes; prefer small,
upstreamable changes for protocol/capability and rendering transport support.

After testing an engine change, push it to the fork **before** committing the
updated submodule pointer in the extension:

```sh
git -C native/texpresso push origin vscode
git add native/texpresso
git commit -m "Update bundled TeXpresso engine"
```

CI builds the committed pointer, never a moving branch tip. MuPDF, ICU, and zlib-ng
versions live in `dependencies.lock.json`; their build profiles live here.
Large dependency trees and compiled artifacts are not committed to Git.

## Initial macOS development build

The offline builder supports native macOS arm64 and x86_64 hosts. It builds
fresh source exports, leaving the supplied source checkouts untouched. Python
3.12+, Xcode command-line tools, make, pkg-config, and installed codec/font
libraries are required. The initial implementation uses Homebrew development
dependencies; it records their actual versions in the build manifest.

Supply a local MuPDF checkout at the locked revision with its locked
`thirdparty/lcms2` submodule initialized, and an ICU 78.3 installation containing
the headers, static `libicuuc.a`, shared data library, `icupkg`, and `genccode`.
Supply a clean zlib-ng checkout at the locked revision as well. Its native API is
statically linked at level 2 for live PNG encoding, independently of system zlib
used by other libraries. The builder verifies the reported backend/version/level
and includes its license. No build command automatically downloads sources or packages.

```sh
python3 native/scripts/build.py --check \
  --mupdf-source /path/to/mupdf --icu-prefix /path/to/icu \
  --zlib-ng-source /path/to/zlib-ng
python3 native/scripts/build.py \
  --mupdf-source /path/to/mupdf --icu-prefix /path/to/icu \
  --zlib-ng-source /path/to/zlib-ng
```

Homebrew prerequisites for a fresh build host are `cmake`, `pkgconf`, `freetype`,
`jpeg-turbo`, `openjpeg`, `brotli`, `sdl2`, `harfbuzz`, `graphite2`, `fontconfig`,
`libpng`, `jbig2dec`, and `icu4c@78`. Installation is a separate, explicit step.
There is no Tectonic requirement.

The result is `native/.bundles/darwin-<architecture>/` and a neighboring ZIP.
Use `--output /new/path` for another build; existing bundles are never replaced.
Work files are retained in `native/.work/` for diagnostics and may be deleted
after the build. Run the result as `.../bin/texpresso -texlive /path/to/main.tex`.

The bundle includes both executables, recursively collected non-system dynamic
libraries, collected dependency notices, and `build-manifest.json`. Mach-O
library references are rewritten relative to the bundle and binaries receive
ad-hoc signatures. SDL2-compat's dynamically loaded SDL3 is included explicitly.
The manifest identifies engine/dependency inputs, profile hashes, the compiler,
host library versions, binary hashes, and available engine features.

The profiles reproduce the size experiment: static MuPDF without HTML, XPS,
OCR, JavaScript, document export, or the large Noto/language-specific CJK fonts;
static ICU with unused locale/formatting/collation data removed. All converters
and line-breaking dictionaries remain. Base14 and smaller CJK fonts remain for
graphics/PDF fallback. The engine supports either its SDL window or the
`-headless -json` editor preview. The build manifest records runtime capability
probe results as well as whether the embedded preview is supported.

## Validation

```sh
python3 -m unittest discover -s native/tests
python3 native/scripts/verify_icu.py --icu-prefix /path/to/icu
TEXPRESSO_BINARY="$PWD/native/.bundles/darwin-arm64/bin/texpresso" npm run test:engine
```

Engine tests use local TeX Live by default. Leave `TEXPRESSO_TEST_TECTONIC`
unset. The ICU comparison checks 12 line-breaking locales, bidirectional text,
legacy encodings, normalization, and script properties against stock ICU.

`native-build.yml` is an explicitly dispatched macOS build matrix for Apple
Silicon (`macos-15`) and Intel (`macos-15-intel`). Source
and package downloads occur on the GitHub runner, with the large source/build
inputs cached. It does not publish a release. It packages the tested bundle into
a platform VSIX and installs it into an isolated VS Code profile to test the
bundled engine with no executable-path override. Accepted VSIXs and checksums
are uploaded separately from native archives and diagnostics.

## Developer ID signing and notarization

The manual **Native macOS bundles and VSIX** workflow signs and notarizes by default.
It tests the ad-hoc bundle first, then signs a separate copy of both executables
and every bundled dylib using Developer ID Application, hardened runtime, and
secure timestamps. All signatures must have the same Team ID. It refreshes the
manifest's binary hashes after signing, submits the resulting ZIP using
`notarytool`, and tests the signed bundle with local TeX Live again.

Repository Actions secrets:

| Secret | Contents |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | The Developer ID Application identity name or certificate SHA-1 |
| `KEYCHAIN_PASSWORD` | Password for the runner's temporary keychain |
| `APPLE_API_KEY` | App Store Connect team API key ID |
| `APPLE_API_ISSUER` | App Store Connect team API issuer UUID |
| `APPLE_API_PRIVATE_KEY` | The matching `.p8` PEM text, or its base64 encoding |

Credentials are scoped to the signing step, imported into a private temporary
keychain, and removed on completion, failure, or cancellation. They are never
included in artifacts. The workflow is manually dispatched, not run on PRs.
Disable its `notarize` input to make only an ad-hoc development bundle; missing
secrets fail a requested notarization rather than silently skipping it.

The `native-macos-<arch>-notarized` artifact is uploaded only after Apple's
`Accepted` result and successful signed-engine tests. It contains the signed ZIP,
its SHA-256, the updated manifest, and Apple's receipt/log. Development ZIPs and
notarization diagnostics are saved separately, including on failure. A submission
ID is saved before waiting so a timeout can be investigated without resubmitting.
Plain Mach-O command-line binaries and ZIP archives cannot have tickets stapled;
Gatekeeper retrieves their notarization tickets online. An offline-stapled
container would require a later DMG or installer packaging step.

For a local CI-like signing run, set the same environment variables and use:

```sh
python3 native/scripts/notarize.py --bundle /path/to/adhoc-bundle \
  --output /path/to/new-signed-bundle --reports /path/to/notarization-reports
```

Signing does not publish a release. The workflow packages the signed bundle into
the VSIX without modifying its native files, then runs installed-VSIX acceptance.

## Platform VSIX packaging

After building a bundle whose engine revision matches the recorded submodule pin:

```sh
npm run package:vsix -- --target darwin-arm64 --bundle native/.bundles/darwin-arm64
VSCODE_EXECUTABLE='/path/to/Code' npm run test:package:preview -- \
  --vsix artifacts/texpresso-1.9.0-darwin-arm64.vsix
```

Use the current `package.json` version in the VSIX filename, or pass `--out` to
choose a stable artifact name. The package script builds JavaScript, stages only
production files, checks bundle hashes and architecture, and preserves executable
permissions. It checks the finished archive and writes a SHA-256 sidecar. Both
executables, libraries, notices, and the native build manifest live under
`runtime/<target>/`. Packaging never changes the input bundle or its signatures.
Run Unix-target packaging on Linux or macOS. Explicit `texpresso.command` settings
override the bundle; an incomplete bundle produces a setup error rather than
silently selecting another engine.

Without `--target` and `--bundle`, `package:vsix` still creates the universal,
external-engine VSIX at `artifacts/texpresso.vsix`.

## Linux builds on GitHub

`linux-build.yml` builds x64 and ARM64 on GitHub runners inside Ubuntu 22.04
containers (glibc 2.35 baseline). Local Docker is not required. The runner
downloads the locked ICU archive, checks its SHA-256, and builds its static core
with the same filtered data profile as macOS. MuPDF and zlib-ng use the locked
source revisions. ELF dependencies are recursively collected with notices and
source-package versions, then relocated using `$ORIGIN` paths. glibc and its
loader remain supplied by the runtime OS, as do graphics drivers and fonts.

The job tests a moved bundle, packages its platform VSIX, and exercises that
installed VSIX through a real VS Code webview. Only accepted VSIXs and checksums
are uploaded as `vsix-linux-x64` and `vsix-linux-arm64`. Downloads and build
caches stay on GitHub; developer machines only need the source checkout.

## Release and Marketplace publishing

Dispatch **Release candidate artifacts** (`release-build.yml`) for a candidate
commit. It builds and tests both signed/notarized macOS targets, both Linux
targets, and the universal fallback. Inspect that run and its artifacts first.

Then dispatch **Publish reviewed release artifacts** (`publish.yml`) with that
successful build run's numeric ID. It downloads the exact artifacts without
rebuilding and checks their complete target set, checksums, extension identity,
stable v2 version, pinned engine, executable permissions, and Mac signing
metadata. The originating build must have passed notarization and installed-VSIX
acceptance. It publishes through GitHub OIDC trusted publishing, with no PAT.
The Marketplace trusted-publishing policy must name `publish.yml` and this
repository; no GitHub environment is used. Both jobs install the latest stable
`vsce` and log its version. Publishing is manual and never runs on PRs.

## Remaining release checks

The initial host build records system dependency versions but is not yet a
fully pinned toolchain. Release work includes pinning the remaining codec/font
dependencies and build SDKs, completing notice/source-distribution review,
building Linux and other supported targets, and testing on clean machines.
The universal VSIX excludes native archives. Platform VSIXs include only the
selected bundle. Local ad-hoc signed candidates are for development; distribution
requires the signed/notarized CI artifacts and platform acceptance results.
