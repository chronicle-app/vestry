# Changelog

## Unreleased

- `survey` counts the records in each export a package holds, using Chronicle's `chronicle` command, and keeps the readers it finds and each dated survey in the catalog. It prints a row per record type, for grep and awk
- `scan` lists the exports Chronicle recognizes outside any package, as folders or ZIPs to package next
- A Chronicle from before `scan` and `survey` is treated like none: `survey` exits 4 and says to update it, and `scan` finds packages only
- `history`, `recover`, and `cache list` print a table with a row per operation or copy, as do the copies and readers in `show` and `scan`, for grep and awk
- `show` lists a package's readers and its latest survey
- Output looks and reads like Chronicle's: a `✓` or `✗` summary line, notices stamped with the time, `✗ Error:` with a `↳` hint that names a command to run, commands in cyan (in backticks without color), and a live progress line at a terminal. Errors in `--json` carry the hint as `hint`
- An ambiguous package names a command to run for each copy, and a mistyped command suggests the one you meant
- `forget PATH` forgets just that copy, as when its drive is gone, rather than the whole package; a package's last copy still forgets the package. `show` suggests it for a copy that's missing

## 0.1.0

First public release.

- `create` packages a folder in place or a ZIP as a packed package
- `check`, `list`, `show`, `edit`, `scan`, `cp`, `mv`, `pack`, `unpack`, `eject`, `forget`
- Catalog of titles, descriptions, notes, copy locations, and operation history kept outside the packages
- Content-based package identity, shared across copies and across packed and expanded forms
- Crash-safe operations with `recover` and explicit `cleanup`
- Expanded packages are BagIt 1.0 bags with SHA-256 manifests
