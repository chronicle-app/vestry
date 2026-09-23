# Contributing

Requires Node 22.2 or newer. TypeScript, ESM, npm, Vitest.

```sh
npm ci
npm link          # builds and puts `vestry` on PATH
npm run dev       # rebuild on change
npm run typecheck
npm test
```

Tests run real filesystem operations, including fsync and killing processes at
publication checkpoints, so the suite takes about a minute. Unlink with
`npm uninstall -g @chronicle.app/vestry`.
