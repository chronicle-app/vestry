# Agent notes

Guidance for AI coding agents working in this repository.

## Attribution

Do not add AI attribution to anything committed. No `Co-Authored-By` lines
for AI tools in commit messages, no "Generated with" footers in pull request
descriptions, and no agent names in code comments or docs. Commits are
authored by the human running the tool.

## Project

Vestry is a TypeScript CLI (ESM, Node 22+) for packaging files as BagIt bags,
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
