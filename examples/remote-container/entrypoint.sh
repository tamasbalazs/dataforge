#!/bin/sh
# Authorize the public key passed in AUTHORIZED_KEYS, then run sshd in the foreground.
set -eu
home="/home/$DF_USER"
if [ -z "${AUTHORIZED_KEYS:-}" ]; then
  echo "AUTHORIZED_KEYS is empty: pass your public key, e.g. -e AUTHORIZED_KEYS=\"\$(cat ~/.ssh/id_ed25519.pub)\"" >&2
  exit 1
fi
install -d -m 700 -o "$DF_USER" -g "$DF_USER" "$home/.ssh"
printf '%s\n' "$AUTHORIZED_KEYS" > "$home/.ssh/authorized_keys"
chown "$DF_USER:$DF_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
