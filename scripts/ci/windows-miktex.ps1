# Disposable GitHub Windows runner only; no developer-machine installation.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installer is for disposable GitHub runners only' }
$diagnostics = Join-Path $PWD 'artifacts/windows-miktex'
$null = New-Item -ItemType Directory -Force $diagnostics
$installer = Join-Path $env:RUNNER_TEMP 'basic-miktex-25.12-x64.exe'
Invoke-WebRequest 'https://miktex.org/download/ctan/systems/win32/miktex/setup/windows-x64/basic-miktex-25.12-x64.exe' -OutFile $installer
if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne '14b42dd9f4b4a7813a8bfd69c8f99316c2888cc4ee26f631f397e163d85d6c62') { throw 'MiKTeX installer checksum mismatch' }
$root = Join-Path $env:RUNNER_TEMP ('MiKTeX bridge caf' + [char]0xe9)
$process = Start-Process $installer -ArgumentList @('--unattended','--private', ('--user-install="' + $root + '"')) -PassThru -Wait -RedirectStandardOutput (Join-Path $diagnostics 'setup.out') -RedirectStandardError (Join-Path $diagnostics 'setup.err')
if ($process.ExitCode) { throw "MiKTeX installer failed: $($process.ExitCode)" }
$bin = Join-Path $root 'miktex/bin/x64'
$miktex = Join-Path $bin 'miktex.exe'; $finder = Join-Path $bin 'findtexmf.exe'
if (!(Test-Path -LiteralPath $finder)) { throw "MiKTeX finder missing: $finder" }
& $miktex packages update-package-database
if ($LASTEXITCODE) { throw 'MiKTeX package database failed' }
& $miktex packages check-update
if ($LASTEXITCODE -notin @(0,100)) { throw 'MiKTeX update check failed' }
& $miktex --disable-installer packages update
if ($LASTEXITCODE) { throw 'MiKTeX package update failed' }
# The cold bridge test must actually fetch a package absent from the basic set.
& $finder --file-type=tex -- csquotes.sty
if (!$LASTEXITCODE) {
  & $miktex packages remove csquotes
  if ($LASTEXITCODE) { throw 'Could not prepare missing csquotes package' }
}
"TEXPRESSO_WINDOWS_MIKTEX_BIN=$bin" >> $env:GITHUB_ENV
# A small fake native lookup + descendant exercises cancellation independently
# of download timing. Compile using Windows PowerShell's .NET Framework csc.
powershell.exe -NoProfile -NonInteractive -File scripts/ci/windows-miktex-fixture.ps1
if ($LASTEXITCODE) { throw 'Windows cancellation fixture compilation failed' }
