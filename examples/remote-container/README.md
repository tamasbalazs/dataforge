# Remote container for DataForge

A container with R (IRkernel), Python (ipykernel, pandas), git and an SSH server.
DataForge connects to it like to any SSH host: files, terminal, git and both kernels
run inside the container.

```bash
./run.sh ~/projects/my-analysis      # mounts the folder at /home/ana/work
```

Then in DataForge: **Remote host (SSH)…** (`Ctrl+Alt+K`) → **New host**:

| Field | Value |
|---|---|
| Host | `127.0.0.1` |
| User | `ana` |
| Port | `2222` |
| Start folder | `/home/ana/work` |

The SSH port is bound to `127.0.0.1` only, password login is disabled, and only the
public key you pass is authorized. Stop it with `docker rm -f dataforge-remote`.

Using your own image instead: it needs `sshd`, `sh`, GNU `find`/coreutils, and for the
kernels Python with `ipykernel` and/or R with `IRkernel` + `jsonlite`.
