# Preserved Turing Wallet provider

`npm view turing-wallet-provider` reported that the package was unpublished on
2026-09-30. The existing registry tarball returned HTTP 404 during a clean Docker
build on 2026-10-27.

This archive was packed from the project's already installed version **1.5.8**
with `npm pack --ignore-scripts`. Runtime files and the upstream README are
preserved without source modifications. It contains no application configuration,
wallet data or private keys. The dependency uses `file:vendor/...` and the lockfile
records npm integrity, so clean builds do not depend on the removed registry URL.
The source package declares no license field; no replacement license is invented.

SHA-256: `7e3aad467aee6c89c611d4d3ddffd687e74d87c5b9cac9d24045fc77cbf22c3f`

When the maintainer provides a supported release, review compatibility and replace
this archive explicitly. Do not silently swap wallet signing implementations.
