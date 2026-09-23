# Vestry

[![npm](https://img.shields.io/npm/v/@chronicle.app/vestry?label=npm)](https://www.npmjs.com/package/@chronicle.app/vestry)
[![CI](https://github.com/chronicle-app/vestry/actions/workflows/ci.yml/badge.svg)](https://github.com/chronicle-app/vestry/actions/workflows/ci.yml)

A personal digital archiving CLI for packaging, verifying, and tracking your
records and exports.

You point it at a folder or a ZIP. It turns that into a **package**: your
original files plus checksums. Later you can check whether anything changed,
make verified copies, move them between disks, and find them again after
reorganizing. Packages are standard BagIt bags, so they stay readable without
Vestry.

## Install

Requires Node 22.2 or newer.

```sh
npm install -g @chronicle.app/vestry
```

The binary is `vestry`. The bare npm name is blocked by the registry's
similarity check for now; a request to release it is pending.

## Usage

**Make a package.** Point `create` at a folder or a ZIP. A folder is sealed
in place. A ZIP is moved unchanged into a packed package next to it.

```sh
vestry create ./photos-2019 --as photos19   # folder becomes a package, in place
vestry create ./instagram-export.zip         # ZIP becomes a packed package
vestry create ./photos-2019 --plan           # preview without writing
```

**Describe it, then find it again.** Titles, descriptions, and notes live in
the catalog, so editing them never changes package bytes. Commands accept a
path, a digest prefix, or an alias.

```sh
vestry edit photos19 --title "Photos 2019" --description "Phone camera roll"
vestry list                                  # every package, with copy counts
vestry show photos19                         # description and all known copies
```

**Check it.** `check` reads every byte and compares it to the manifests.

```sh
vestry check photos19
```

**Keep a second copy, and move things around.** `cp` writes a verified copy
and registers it. `mv` relocates a package but keeps the original in a
recovery folder until you run the `cleanup` command it prints. `scan` re-finds
packages on a disk you reorganized or plugged back in.

```sh
vestry cp photos19 /Volumes/Backup/photos-2019   # verified copy, original kept
vestry mv photos19 ~/Archive/photos-2019          # verified move
vestry cleanup OPERATION-ID                       # free the retained original
vestry scan /Volumes/Backup                       # rediscover packages
```

Destinations are exact new package paths inside an existing directory. Add
`--json` to any command for scripts.

## How it works

**A package is a folder.** Your files live under `data/`. Next to them are
SHA-256 manifests and a small amount of format metadata. A package created from
a ZIP keeps the ZIP unchanged as `data.zip` instead of extracting it. `pack` and
`unpack` switch between the two forms without changing the package's identity.

**Checksums detect damage. Copies recover from it.** `check` reads every byte
and compares it to the manifests. Vestry never repairs a package in place; you
keep a second copy and `cp` from it.

**The catalog is separate from the files.** Packages are the source of
truth. The catalog is a small local index on top of them: titles, descriptions,
notes, where each copy lives, and what operations ran. It lives outside your
archive, in the platform's application-data directory:

| macOS | `~/Library/Application Support/Vestry` |
| --- | --- |
| Linux | `$XDG_DATA_HOME/vestry` or `~/.local/share/vestry` |
| Windows | `%APPDATA%\Vestry` |

Pass `--home DIR` to use a different one. The two are complementary: the
catalog makes packages findable and describable, and the packages stay complete
and verifiable if the catalog is ever lost. `scan` rebuilds the location index
from disk. Notes and history exist only in the catalog, so back it up too.

**Identity is content.** A package is identified by the digest of its
filenames and bytes. Two imports of the same export get the same ID no matter
where they live or whether they are packed. Commands accept a path, a digest
prefix, or an alias.

**Nothing is deleted quietly.** `mv` and `eject` keep the original in a
recovery folder until you run the printed `vestry cleanup` command. Interrupted
operations resume with `vestry recover`.

## Commands

| Command | What it does |
| --- | --- |
| `create PATH` | Create a package from a folder in place, or turn a ZIP into a packed package |
| `list` | Show packages and counts of available and missing copies |
| `show PACKAGE` | Show description and all known copies; does not check integrity |
| `edit PACKAGE` | Update title, description, or notes without changing package bytes |
| `check PACKAGE` | Read the selected copy and verify its integrity |
| `scan DIR` | Find and verify packages in a directory tree, then register their locations |
| `pack PACKAGE` | Replace `data/` with `data.zip` in place; identity unchanged |
| `unpack PACKAGE` | Replace `data.zip` with `data/` in place; identity unchanged |
| `cp PACKAGE DESTINATION` | Copy to a new package path, verify the copy, keep the original |
| `mv PACKAGE DESTINATION` | Relocate; the original stays in a recovery folder until `cleanup` |
| `eject PACKAGE` | Restore payload files to the package folder, retaining the package for recovery |
| `forget PACKAGE` | Remove registration and aliases; files, managed copies, and history are kept |

`PACKAGE` is a path, a full digest, or an unambiguous digest prefix. Aliases
also work. When several copies are available you choose interactively, or pass
a path in scripts.

Advanced commands: `cleanup`, `history`, `recover`, `register`, `cache`,
`gather`, `describe`. Run `vestry COMMAND --help` for options.

Common options:

| Option | Effect |
| --- | --- |
| `--plan` | Preview `create`, `cp`, `mv`, `pack`, `unpack` without writing |
| `--json` | One machine-readable result, no formatting |
| `--events` | NDJSON progress and result |
| `--quiet` | Hide routine progress; keep results and errors |
| `--offline` | Resolve reads through managed local copies only |
| `--color MODE` | `auto`, `always`, `never`; respects `NO_COLOR` |
| `--home DIR` | Use a separate catalog (normally automatic) |

## BagIt

Expanded packages are [BagIt 1.0](https://www.rfc-editor.org/rfc/rfc8493.html)
bags: a `bagit.txt` declaration, your files under `data/`, SHA-256 payload and
tag manifests, and `bag-info.txt`. Any BagIt tool, such as `bagit-python`, can
verify one without Vestry.

Where Vestry differs:

- **Packed form.** `data.zip` in place of `data/` is a Vestry extension. The
  manifests still describe the files inside the ZIP, but it is not a complete
  bag until unpacked.
- **Extra tag file.** `timestamps.json` records payload modification times so
  pack and unpack can restore them. It is checksummed like any other tag file.
- **Identity lives outside the bag.** The Content ID is a digest of the payload
  computed by Vestry and stored in the catalog. BagIt has no equivalent.
- **Narrower on input.** Vestry currently requires SHA-256 manifests, a
  `Payload-Oxum`, and its own fixed tag set. A valid bag made by another tool
  may be rejected for now. Accepting more of the standard is on the roadmap.

## Chronicle

Vestry is the intake layer for [Chronicle](https://chronicle.app)
([source](https://github.com/chronicle-app/chronicle/)), which turns personal
data exports into a searchable, connected history. Each works without the
other; the roadmap below covers how they connect.

## Roadmap

**Today.** Create packages from folders and ZIPs, verify them, keep copies on
several disks, describe them, and find them again after reorganizing.

**Next.** Survey. Look inside an export before packaging it: list what it
contains, which formats are present, and what looks damaged or has names that
will not survive a filesystem. Reports are dated and kept in the catalog, so
you can tell what you knew about a file and when.

**Later.** Processing. Attach code to a package and run it against a verified
copy. Vestry records each run and its outputs but never lets a processor touch
package bytes. [Chronicle's source plugins](https://github.com/chronicle-app/chronicle#sources)
are the first processors: an Instagram or Google export gets read by code that
understands that format, and the result flows into Chronicle.

**Housekeeping.** Accept more existing BagIt bags without rewriting them.
Qualify NAS and Windows, which are untested today.

## The name

The vestry of an English parish church began as its wardrobe: the room where
the vestments and the plate were kept. But it became known for the chest that
sat in it. From 1538 every parish had to keep a register of baptisms,
marriages, and burials in
[a locked coffer](https://tudortreasures.net/thomas-cromwell-and-the-parish-registry/),
and the coffer soon held
[the surveys of church land and the minutes of what the parish had decided](https://www.whodoyouthinkyouaremagazine.com/tutorials/religious/parish-chest).
The vestry was where you went to find out what the parish owned, where it was,
and what had been done about it.

That is the job this tool takes on. Your files stay on whatever disks you
choose. Vestry keeps the account: what each package is, where the copies are,
when they were last checked, and what has been done to them.

## Develop

```sh
npm ci && npm link
npm test
```
