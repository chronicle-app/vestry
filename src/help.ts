/** A flag as help lists it: how it's typed, the value it takes, and what it does. */
export type Flag = [name: string, value: string | undefined, text: string];

/** What `vestry COMMAND --help` says: a line on what it does, then the details and its flags. */
export interface CommandHelp {
  summary: string;
  /** Paragraphs, with commands and flags in backticks. */
  details?: string[];
  flags?: Flag[];
}

const plan: Flag = ['--plan', undefined, 'Show what would be read and written, and change nothing'];
const location: Flag = ['--location', 'PATH', 'The copy to use, when there are several'];

export const COMMANDS: Record<string, CommandHelp> = {
  create: {
    summary: 'Make a package from a folder, in place, or from a ZIP',
    details: [
      'A folder becomes a package at the same path: its files move under data/, beside their checksums. A ZIP moves unchanged into a new packed package next to it, named without .zip; with `--output`, the ZIP is copied and the original stays. Allow space for a full copy while it works.',
      'For a folder that holds only one ZIP, it asks whether to package the files inside the ZIP or keep the ZIP as one file. In scripts, pass `--zip-contents` or `--keep-zip`; nothing is extracted to disk either way.',
      'Run it from outside the folder, such as its parent. If it\'s interrupted, run it again to pick up where it stopped. A description is optional; `--description` and `--readme` keep one in the catalog, where `vestry edit` can change it.',
    ],
    flags: [
      ['--description', 'TEXT', 'A one-line description, kept in the catalog'],
      ['--readme', 'FILE', 'Notes to keep in the catalog'],
      ['--as', 'NAME', 'An alias to use in place of the path'],
      ['--packed', undefined, 'Keep the files in data.zip rather than data/'],
      ['--output', 'DIR', 'For a ZIP or a draft, where to make the package. The source stays'],
      ['--zip-contents', undefined, 'For a folder holding one ZIP, package the files inside it'],
      ['--keep-zip', undefined, 'For a folder holding one ZIP, keep the ZIP as one file'],
      ['--restart', undefined, 'Throw away an interrupted create\'s work and start again'],
      ['--from-draft', undefined, 'Package a draft made with `vestry gather`. Needs `--output`'],
      plan,
    ],
  },
  list: { summary: 'Show your packages and how many of their copies are available' },
  show: {
    summary: 'Show a package\'s description and every known copy',
    details: ['Nothing is read from the copies themselves. Run `vestry check` to compare a copy with its checksums.'],
  },
  edit: {
    summary: 'Change a package\'s title, description, or notes',
    details: ['They live in the catalog, so the package\'s files never change. Empty text clears a field. Back up the catalog to keep them.'],
    flags: [
      ['--title', 'TEXT', 'A title'],
      ['--description', 'TEXT', 'A one-line description'],
      ['--notes', 'FILE', 'Notes, read from a file'],
    ],
  },
  check: {
    summary: 'Read every file in a copy and compare it with its checksums',
    flags: [location],
  },
  survey: {
    summary: 'Count the records in each export a package holds, with Chronicle',
    details: [
      'Chronicle finds each export in the package and the source that reads it. Vestry keeps these readers by Content ID, so they serve every copy and form. Use `--find` to ask again, as after updating Chronicle or its plugins.',
      'It prints a row per record type. Exports that weren\'t counted are named on stderr, and `--json` has everything. Each survey is kept in the catalog, and `vestry show` prints the latest.',
      'In a packed copy, ZIPs inside data.zip are copied to the cache while Chronicle reads them, then removed, so allow space for them. Install Chronicle with `npm install -g @chronicle.app/cli`. Exits 1 when Chronicle couldn\'t count an export.',
    ],
    flags: [
      ['--check', undefined, 'Check the copy\'s files first. Otherwise the identity is taken from the catalog'],
      ['--find', undefined, 'Ask Chronicle again which exports the package holds'],
      location,
    ],
  },
  scan: {
    summary: 'Find and check the packages in a folder, and register where they are',
    details: [
      'Every folder below is searched for packages, but not the inside of a package. Symlinks, drafts, the catalog, and recovery folders are skipped. With Chronicle installed, it also lists the exports Chronicle recognizes outside any package, as folders or ZIPs to package with `vestry create`.',
      'A package keeps the main copy it has. When several copies turn up and none is the main one, pick it with `vestry register PATH --main`. Exits 1 when a package couldn\'t be checked or needs its main copy picked.',
    ],
    flags: [['--make-main', undefined, 'Make each copy found the main one, when it\'s the only copy found']],
  },
  pack: {
    summary: 'Replace data/ with data.zip, keeping the package\'s identity',
    details: ['The copy is converted where it is, so run it from outside the package. Allow space for both forms until the new one is checked.'],
    flags: [
      ['--output', 'DIR', 'Make a separate packed copy instead, and keep this one'],
      ['--compress', undefined, 'Compress the files in data.zip'],
      ['--zip64', undefined, 'Write data.zip as ZIP64'],
      location,
      plan,
    ],
  },
  unpack: {
    summary: 'Replace data.zip with data/, keeping the package\'s identity',
    details: ['The copy is converted where it is, so run it from outside the package. Allow space for both forms until the new one is checked.'],
    flags: [['--output', 'DIR', 'Make a separate expanded copy instead, and keep this one'], location, plan],
  },
  cp: {
    summary: 'Copy a package, check the copy, and keep the original',
    details: ['DESTINATION is the new package\'s path. It mustn\'t exist yet, but the folder it goes in must.'],
    flags: [plan],
  },
  mv: {
    summary: 'Move a package, keeping the original until you clean it up',
    details: [
      'DESTINATION is the new package\'s path. It mustn\'t exist yet, but the folder it goes in must.',
      'The original stays in a recovery folder until you run the `vestry cleanup` command it prints.',
    ],
    flags: [plan],
  },
  eject: {
    summary: 'Turn a package back into a plain folder of its files',
    details: [
      'The files go back where the package was, and the package stays in a recovery folder until you run the `vestry cleanup` command it prints. A packed package\'s files are extracted. Run it from outside the package.',
    ],
    flags: [['--keep-zip', undefined, 'Restore data.zip as it is, under its original name, or payload.zip']],
  },
  forget: {
    summary: 'Remove a package and its aliases from the catalog',
    details: ['Its files, cached copies, and history stay.'],
  },
  cleanup: {
    summary: 'Remove the original that a move or eject kept',
    details: ['Only the recovery copy recorded for that operation is removed, once the new copy is checked and flushed to disk. If the move couldn\'t flush everything to disk, the recovery copy stays.'],
  },
  history: { summary: 'Show the operations recorded, including failed and interrupted ones' },
  recover: {
    summary: 'List unfinished operations, or finish one',
    details: ['With an operation ID, it picks up from the checked copy in staging. Each unlock first checks that the process holding the lock is gone.'],
    flags: [
      ['--discard', undefined, 'Throw away an unfinished operation\'s temporary work'],
      ['--release-lock', undefined, 'Unlock an operation whose process was killed'],
      ['--release-registry-lock', undefined, 'Unlock the catalog after the process holding it was killed'],
    ],
  },
  register: {
    summary: 'Check a package and remember where it is',
    flags: [['--as', 'NAME', 'An alias to use in place of the path'], ['--main', undefined, 'Make this the main copy']],
  },
  cache: {
    summary: 'Keep checked copies for when your archive is offline',
    details: ['A pinned copy stays until you unpin it. Others can be evicted to free space.'],
    flags: [['--pin', undefined, 'With add, keep the copy until you unpin it'], location],
  },
  gather: {
    summary: 'Copy files into a new draft, to describe before packaging',
    details: ['The originals stay as they are. Package the draft with `vestry create DRAFT --from-draft --output DIR`.'],
    flags: [['--into', 'DRAFT', 'The new draft\'s folder'], plan],
  },
  describe: {
    summary: 'Edit a draft\'s description or README',
    flags: [
      ['--edit', undefined, 'Open the README in $VISUAL or $EDITOR'],
      ['--readme', 'FILE', 'Read the README from a file'],
      ['--description', 'TEXT', 'A one-line description'],
    ],
  },
  move: { summary: 'The older spelling of `vestry mv`', flags: [['--to', 'DIR', 'Where to move the package'], plan] },
  verify: { summary: 'The older name for `vestry check`', flags: [location] },
  inspect: { summary: 'Check a copy, then show its description and every known copy', flags: [location] },
  locate: { summary: 'Show where a package\'s copies are, without checking them' },
};

/** The commands the root help lists first, and the rest. */
export const EVERYDAY = ['create', 'list', 'show', 'edit', 'check', 'survey', 'scan', 'pack', 'unpack', 'cp', 'mv', 'eject', 'forget'];
export const MORE = ['cleanup', 'history', 'recover', 'register', 'cache', 'gather', 'describe'];

export const GLOBAL_FLAGS: Flag[] = [
  ['--home', 'DIR', 'Use a separate catalog, rather than this computer\'s usual one'],
  ['--offline', undefined, 'Read only the copies in the cache'],
  ['--json', undefined, 'Print one result as JSON, for scripts'],
  ['--events', undefined, 'Print progress and the result as JSON lines'],
  ['-q, --quiet', undefined, 'Print only results, warnings, and errors'],
  ['--color', 'MODE', '`auto`, `always`, or `never`. `NO_COLOR` works too'],
  ['-h, --help', undefined, 'Show help'],
];
