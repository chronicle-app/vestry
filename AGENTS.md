# Agent notes

Guidance for AI coding agents working in this repository.

## Attribution

Do not add AI attribution to anything committed. No `Co-Authored-By` lines
for AI tools in commit messages, no "Generated with" footers in pull request
descriptions, and no agent names in code comments or docs. Commits are
authored by the human running the tool.

## Project

Vestry is a TypeScript CLI (ESM, Node 22.13+) for packaging files as BagIt bags,
verifying them, and tracking copies in a local catalog. Entry point is
`bin/vestry.js`, which loads the built `dist/src/cli.js`.

```sh
npm ci
npm run typecheck
npm test            # builds first; about a minute, runs real fsync and kill tests
npm run build
```

## Conventions

- Keep `README.md` short. Detailed behavior belongs in `vestry COMMAND --help`,
  not in docs files. Do not add a `docs/` directory.
- On-disk names and digest prefixes use `vestry-`, never `catalog-`.
- Package bytes are never modified by metadata or processing operations.
  Anything that edits a package must go through the staged, verified,
  recoverable publication path in `src/operations.ts`.
- Run the full test suite before committing. If a test fails only under
  parallel load, raise timeouts in `vitest.config.ts` rather than skipping it.
- Test errors by behavior, not wording: the exit code, the error's `code`,
  and that its `hint` names the command it points at.

## Output

Vestry looks and reads like Chronicle. Messages are Chronicle's
`@chronicle.app/logging` events: a `kind`, a `level`, a plain `message`, and
a `hint`. `src/output/` is a port of Chronicle's `apps/cli/src/output/`,
without chalk: the blocks, and the pretty and plain sinks that render those
events, built on the package's `TextSink`. It's the only place terminal text
is styled; `src/terminal.ts` builds every screen from it. Don't write ANSI
codes anywhere else.

- **Results go to stdout; everything else to stderr** as events on the
  terminal's logger: notices, warnings, errors, hints, and progress. Repeats
  roll up as Chronicle's do: three examples, then a count.
- **A result starts with a summary line**: status glyph, what happened, the
  time it took (`✓ Package created  in 212ms`), then its details as a card.
  A lookup like `show` starts with the package's name instead.
- **A list is a table**, as Chronicle's are: a row per item under muted
  headings and a rule, so grep and awk can read it. A cell is one word: `-`
  for nothing, plain numbers (`1632`), sizes run together (`4.2MB`), dates
  as `2026-07-15`, and a time in a column of its own. A path goes last and
  prints whole. Notes about rows, like what failed, go under the table.
- **Errors** read `✗ Error: <message>`, with what to do as a `↳` hint below.
  Throw a `VestryError` (or `usage`, `integrity`, `conflict`) with the hint as
  its last argument; it shows in `--json` errors as `hint` too.
- **Color only carries meaning** (`tokens`): status (`success`, `danger`,
  `warning`), `strong`, `muted`, one `accent` for live elements, and cyan for
  something to type (`code`, `command`). Without color, a code span keeps its
  backticks, since they're all that mark it.
- **One glyph set** (`glyphs`): `✓ ✗ ! · → ↳ ━ ─ …`, braille spinner frames,
  and `❯` in the picker. No boxes, no `====` underlines, no emoji.
- **At a terminal**, notices and errors end with the time, right-aligned and
  muted, and progress is a live line redrawn in place. **In a pipe or file**,
  each line starts with the time, and a long command logs a line every 10
  seconds.
- **Paths** print from `~`, and from here in notices. Paths, IDs, and commands
  are never cut: a long one wraps whole. **Numbers** grouped (`1,240`),
  **sizes** in Finder's units (`4.2 MB`), **dates** local to the minute,
  **durations** as spoken (`40ms`, `4.2s`, `3m 07s`).
- **Text from packages and the catalog goes through `clean`**, so control
  characters in it can't drive the terminal.

## Writing messages

Errors, hints, notices, and help are read by someone who is stuck. Write
them the way a person who knows the tool would say it out loud.

```
✗ Error: notes has 2 copies available
  ↳ Pick one:
      vestry pack ~/Archive/notes
      vestry pack /Volumes/Backup/notes
```

- **The error says what happened** in a few words, with no period and no
  advice: `Unknown command lst`, `Destination exists: ~/Archive/photos`.
- **The hint is one or two plain sentences**, ending in a period, with
  commands inline in backticks: "Run `vestry recover` to see what's
  unfinished." "Use `--zip-contents` or `--keep-zip`." "Did you mean
  `vestry list`?" A sentence that ends in a command puts it on a line of its
  own.
- **Commands are real and runnable as printed**: fill in the path or ID you
  have. Placeholders only for what the person alone knows (`PATH`, `DIR`).
  `Terminal` adds the `--home` a person passed to each vestry command in a
  hint, so don't write "with the same --home".
- **Use plain verbs and contractions**: run, use, pass, pick, keep. Not
  "ensure", "retain", "proceed", "utilize", "is not supported by".
- **Don't describe the program** ("Vestry will…", "it reads") or narrate
  ("Preparing the following…"). State the fact: "The original is kept."
- **Don't join phrases with `·` or `;`** in a message; write two sentences.

Read a message aloud before committing it. If it sounds like a form, a
manual, or a chatbot, rewrite it.
