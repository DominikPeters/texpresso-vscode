#!/usr/bin/env bash
# Disposable CI WSL distribution only; never installs on a developer machine.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
if ! command -v gpg >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl gnupg ca-certificates
fi
curl -fsSL https://miktex.org/download/key | gpg --dearmor -o /usr/share/keyrings/miktex.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/miktex.gpg] https://miktex.org/download/ubuntu noble universe' > /etc/apt/sources.list.d/miktex.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends miktex
miktexsetup finish
export PATH="$HOME/bin:$HOME/.miktex/texmfs/install/miktex/bin:$PATH"
retry_metadata() {
  for attempt in 1 2 3; do
    status=0
    miktex packages "$@" || status=$?
    if [ "$status" -eq 0 ] || { [ "$1" = check-update ] && [ "$status" -eq 100 ]; }; then return 0; fi
    if [ "$attempt" -eq 3 ]; then return "$status"; fi
    sleep 5
  done
}
retry_metadata update-package-database
retry_metadata check-update
retry_metadata update
# Official, pinned portable Linux Tectonic build; record its hash in diagnostics.
curl -fL --retry 3 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz' -o /tmp/texpresso-benchmark-tectonic.tar.gz
sha256sum /tmp/texpresso-benchmark-tectonic.tar.gz
tar -xzf /tmp/texpresso-benchmark-tectonic.tar.gz -C /usr/local/bin tectonic
rm /tmp/texpresso-benchmark-tectonic.tar.gz
tectonic --version
findtexmf --version
kpsewhich --version | head -n 1
