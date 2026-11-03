# stanc.js

The Stan compiler (stanc3) compiled to JavaScript, used by the editor for live
diagnostics, formatting and model information. It runs in a Web Worker
(src/stan/stanc.worker.ts) without access to files, the network or the app.

- Version: stanc3 v2.36.0 (matches CmdStan 2.36)
- Source: https://github.com/stan-dev/stanc3/releases/download/v2.36.0/stanc.js
- License: BSD 3-Clause (https://github.com/stan-dev/stanc3/blob/master/LICENSE)
- SHA-256: see SHA256SUMS (checked by `pnpm test`)

Update: download the release asset of the new version, replace this file and SHA256SUMS.
