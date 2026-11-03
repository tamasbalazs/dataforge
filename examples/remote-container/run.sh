#!/usr/bin/env bash
# Build and start the DataForge remote container.
#   ./run.sh [project-folder] [port]
# The project folder is mounted at /home/ana/work; sshd listens on 127.0.0.1:<port> only.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT="$(cd "${1:-$PWD}" && pwd)"
PORT="${2:-2222}"
KEY=""
for k in ~/.ssh/id_ed25519.pub ~/.ssh/id_ecdsa.pub ~/.ssh/id_rsa.pub; do
  [[ -f "$k" ]] && { KEY="$(cat "$k")"; break; }
done
[[ -n "$KEY" ]] || { echo "No SSH public key found – create one with: ssh-keygen -t ed25519" >&2; exit 1; }

docker build -t dataforge-remote .
docker rm -f dataforge-remote >/dev/null 2>&1 || true
docker run -d --name dataforge-remote \
  -p "127.0.0.1:${PORT}:22" \
  -e AUTHORIZED_KEYS="$KEY" \
  -v "$PROJECT:/home/ana/work" \
  dataforge-remote >/dev/null

echo "Ready. In DataForge: Remote host (SSH)… → New host"
echo "  Host: 127.0.0.1   User: ana   Port: ${PORT}   Start folder: /home/ana/work"
