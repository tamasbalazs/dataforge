#!/usr/bin/env bash
# Verify a downloaded DataForge release: the GPG signature of SHA256SUMS and the
# checksums of the installers present in the folder.
#
#   scripts/verify-release.sh [folder]        (default: current folder)
#
# Import the maintainers' public key once first:  gpg --import dataforge-release-key.asc
set -euo pipefail
dir="${1:-.}"
cd "$dir"
[[ -f SHA256SUMS ]] || { echo "✗ SHA256SUMS not found in $(pwd)" >&2; exit 1; }

if [[ -f SHA256SUMS.asc ]]; then
  if gpg --batch --verify SHA256SUMS.asc SHA256SUMS 2>/tmp/dataforge-verify.$$; then
    echo "✓ signature: $(grep -o 'Good signature from .*' /tmp/dataforge-verify.$$ | head -1)"
  else
    cat /tmp/dataforge-verify.$$ >&2
    rm -f /tmp/dataforge-verify.$$
    echo "✗ the signature of SHA256SUMS is NOT valid – do not install" >&2
    exit 1
  fi
  rm -f /tmp/dataforge-verify.$$
else
  echo "! SHA256SUMS.asc missing: checksums can only show the download is intact, not who made it" >&2
fi

if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
checked=0
while read -r hash name; do
  [[ -f "$name" ]] || continue
  actual="$("${sum[@]}" "$name" | cut -d' ' -f1)"
  if [[ "$actual" == "$hash" ]]; then
    echo "✓ $name"
  else
    echo "✗ $name: checksum mismatch – do not install" >&2
    exit 1
  fi
  checked=$((checked + 1))
done < SHA256SUMS
[[ $checked -gt 0 ]] || { echo "✗ none of the files listed in SHA256SUMS is here" >&2; exit 1; }
echo "✓ $checked file(s) verified"
