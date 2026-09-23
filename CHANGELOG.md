# Changelog

## 0.1.0

First public release.

- `create` packages a folder in place or a ZIP as a packed package
- `check`, `list`, `show`, `edit`, `scan`, `cp`, `mv`, `pack`, `unpack`, `eject`, `forget`
- Catalog of titles, descriptions, notes, copy locations, and operation history kept outside the packages
- Content-based package identity, shared across copies and across packed and expanded forms
- Crash-safe operations with `recover` and explicit `cleanup`
- Expanded packages are BagIt 1.0 bags with SHA-256 manifests
