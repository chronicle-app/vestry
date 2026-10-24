import { chooseCopy } from './copy-picker.js';
import { createInterface } from 'node:readline/promises';
import { exists } from './fs-util.js';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gather, describe, readDraft } from './draft.js';
import { sealDraft, convertPackage, verifyRecorded, checkOutput } from './workflow.js';
import { cleanupMove, listOperations, recover, homePath, type Context } from './operations.js';
import { VestryError, diagnostic, usage } from './errors.js';
import { contentRecords, editMetadata, forgetPackage, listPackages, locate, readRegistry, rememberVerified, resolveIdentity, resolveReference, releaseRegistryLock, withPaths, withReference } from './registry.js';
import { singleZipDirectory, copyArchive, packageReference, adoptMain, conversionReference, convertInPlace, createPackage, creationPaths, movePackage } from './locations.js';
import { cacheCopy, cacheEvict, cacheList } from './cache.js';
import type { Verification } from './package.js';
import { Terminal, colorEnabled, type ColorMode } from './terminal.js';
import { clean, pathArg, shellArg, tokens } from './output/index.js';
import { ejectPackage } from './eject.js';
import { scanDirectory } from './scan.js';
import { surveyPackage, surveyed } from './survey.js';

const help = `vestry — standalone preservation packages

Usage:
  vestry create DIR [--description TEXT] [--readme FILE] [--as NAME] [--packed]
  vestry create FILE.zip [--output DIR] [--description TEXT] [--readme FILE] [--as NAME]
  vestry list
  vestry scan DIR [--make-main]
  vestry show PACKAGE
  vestry check PACKAGE
  vestry survey PACKAGE [--check] [--find]
  vestry cp PACKAGE DESTINATION
  vestry mv PACKAGE DESTINATION
  vestry eject PACKAGE [--keep-zip]
  vestry cleanup OPERATION-ID
  vestry move REF --to DIR
  vestry gather PATH... --into DRAFT
  vestry describe DRAFT [--description TEXT] [--readme FILE] [--edit]
  vestry create DRAFT --from-draft --output DIR [--packed]
  vestry edit PACKAGE [--title TEXT] [--description TEXT] [--notes FILE]
  vestry register PATH [--as NAME] [--main]
  vestry forget PACKAGE
  vestry locate REF
  vestry inspect REF
  vestry verify REF
  vestry pack PACKAGE [--output DIR] [--compress] [--zip64] [--location PATH]
  vestry unpack PACKAGE [--output DIR] [--location PATH]
  vestry cache add REF [--pin]
  vestry cache list
  vestry cache pin REF
  vestry cache unpin REF
  vestry cache evict REF
  vestry history [REF]
  vestry recover [OPERATION-ID] [--discard]

Options:
  --home DIR       Optional Vestry records directory (default: platform app-data folder)
  --json           One versioned result on stdout
  --events         Versioned NDJSON progress and final result (excludes --json)
  --plan           Preview create/cp/mv/gather/pack/unpack without writing
  --offline        Resolve aliases/digests only through managed local copies
  --color MODE     auto, always, never (default: auto; respects NO_COLOR)
  --no-color       Disable terminal colors
  --quiet, -q      Suppress routine progress
  --help, -h       Show help

create turns an existing folder into a package at the same path, placing its
original contents under data/ (or data.zip with --packed). Temporary space for a
full copy is required. list shows each package's main location and availability.
ZIP input creates a packed package in a sibling folder named without .zip, or at
--output DIR. Its entries become the payload; the unchanged archive becomes
data.zip. By default the original ZIP is moved, without copying or recompression.
With --output DIR, the ZIP is copied and the original is retained.
create requires no description. Optional description/readme flags store editable catalog metadata. Run create/move from outside
the source directory, such as its parent.
cp copies and verifies a package, retaining the source. mv publishes a verified copy
and retains the original in a recovery folder until cleanup OPERATION-ID.
move REF --to DIR is a compatibility spelling of mv. Destinations must be new directories with existing parents.
register --main designates an existing verified copy as main without moving files.
forget removes a package's registration and all aliases, keeping files and history.
scan discovers and verifies packages below a directory, stopping at each package,
and lists the exports Chronicle recognizes outside them, if chronicle is installed.
--make-main adopts unique discovered copies. Duplicate copies require a choice.
gather and create --from-draft retain sources. A gathered folder retains its top-level name.
Use describe --edit with $EDITOR, or --readme FILE, or --description TEXT.
inspect performs full verification. Packed packages require expansion for BagIt.
recover lists unfinished operations; recover ID resumes verified staging;
recover ID --discard removes owned incomplete staging and empty reservations.
recover ID --release-lock releases a killed recovery process's lock after checking
its recorded host and PID; a live recovery process cannot be unlocked.
REF accepts a path, alias, Content ID (payload digest), or unambiguous digest prefix.
Legacy package digests still work. Each copy retains its package digest for integrity.
Existing paths take precedence over aliases. Explicit paths remain explicit even
with --offline; alias/digest lookups then skip external archive locations.
Pinned copies are durable; eviction refuses pinned or active copies.
recover --release-registry-lock releases a dead owner's registry mutation lock.
pack/unpack convert the selected copy in place. Multiple available copies require
a choice interactively, or an explicit path in scripts.
An explicit path or --location selects a particular copy. --output keeps the source
and creates a separate copy. Run in-place conversion from outside the package.
survey counts the records in each export a package holds, using the chronicle
command. Readers and surveys are kept in Vestry records.
Processor execution is not yet present.
`;

const allowed: Record<string, string[]> = {
  eject: ['keep-zip'], show: [], check: ['location'], cp: ['plan'], mv: ['plan'], cleanup: [],
  scan: ['make-main'], survey: ['check', 'find', 'location'],
  edit: ['title', 'description', 'notes'],
  create: ['zip-contents', 'keep-zip', 'restart', 'from-draft', 'description', 'readme', 'as', 'packed', 'plan', 'output'], list: [], move: ['to', 'plan'],
  gather: ['into', 'plan'], describe: ['description', 'readme', 'edit'],
  pack: ['output', 'compress', 'zip64', 'plan', 'location'],
  unpack: ['output', 'plan', 'location'], inspect: ['location'], verify: ['location'], history: [],
  register: ['as', 'main'], forget: [], locate: [], cache: ['pin', 'location'], recover: ['discard', 'release-lock', 'release-registry-lock'],
};
const common = ['home', 'json', 'events', 'quiet', 'help', 'offline', 'color', 'no-color'];
/** What each command takes, for the error when it gets the wrong number. */
const takes: Record<string, string> = { create: 'path', scan: 'folder', describe: 'draft', cleanup: 'operation ID', register: 'path', locate: 'reference', history: 'reference', recover: 'operation ID' };

/** The command a mistyped one most likely meant, if one is close. */
function closest(typed: string): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (const [i, x] of [...a].entries()) row = row.reduce((next, _, j) => [...next, j === 0 ? i + 1 : Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (x === b[j - 1] ? 0 : 1))], [] as number[]);
    return row[b.length];
  };
  if (typed.length < 3) return undefined;
  return Object.keys(allowed).map(name => [name, distance(typed, name)] as const).filter(([, d]) => d <= (typed.length > 4 ? 2 : 1)).sort((a, b) => a[1] - b[1])[0]?.[0];
}

/** A parse error from node:util as a person would say it. */
function parseFailure(error: NodeJS.ErrnoException, args: string[]) {
  const option = /'(?:-\w, )?(-[^' ]+)/.exec(error.message)?.[1];
  const command = args.find(arg => Object.hasOwn(allowed, arg));
  const flags = command ? `Run \`vestry ${command} --help\` to see its flags.` : 'Run `vestry --help` to see the flags.';
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) return usage(`Unknown flag ${option}`, flags);
  if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return usage(error.message.includes('does not take') ? `${option} doesn't take a value` : `${option} needs a value`, flags);
  return usage(error.message);
}

export async function main(args: string[]): Promise<number> {
  const terminal = new Terminal();
  let activeCommand = '';
  let lastActivityEvent = 0;
  const quarantined: import('./quarantine.js').QuarantineReport[] = [];
  let json = args.includes('--json'), events = args.includes('--events') && !json;
  let retry: ((candidate: string) => string) | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new VestryError('INTERRUPTED', 'Interrupted', 130, {}, 'Run `vestry recover` to see what was left unfinished.'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const emit = (type: string, data: Record<string, unknown>) => console.log(JSON.stringify({ schemaVersion: 1, type, ...data }));
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: {
        output: { type: 'string' }, into: { type: 'string' }, home: { type: 'string' },
        to: { type: 'string' }, main: { type: 'boolean' },
        'make-main': { type: 'boolean' }, check: { type: 'boolean' }, find: { type: 'boolean' },
        'zip-contents': { type: 'boolean' }, 'keep-zip': { type: 'boolean' }, restart: { type: 'boolean' }, 'from-draft': { type: 'boolean' }, title: { type: 'string' }, notes: { type: 'string' },
        description: { type: 'string' }, readme: { type: 'string' }, edit: { type: 'boolean' },
        as: { type: 'string' }, pin: { type: 'boolean' }, location: { type: 'string' }, 'release-registry-lock': { type: 'boolean' },
        packed: { type: 'boolean' }, compress: { type: 'boolean' }, zip64: { type: 'boolean' },
        discard: { type: 'boolean' }, 'release-lock': { type: 'boolean' }, plan: { type: 'boolean' }, offline: { type: 'boolean' },
        json: { type: 'boolean' }, events: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' }, color: { type: 'string' }, 'no-color': { type: 'boolean' },
      }});
    } catch (error) { throw parseFailure(error as NodeJS.ErrnoException, args); }
    const { values, positionals } = parsed;
    activeCommand = positionals[0] ?? '';
    // The command as typed, with its package swapped for another, so an error can offer one to run for each copy it names.
    const reference = parsed.tokens.filter(token => token.kind === 'positional')[activeCommand === 'cache' ? 2 : 1]?.index;
    retry = reference === undefined ? undefined : candidate => ['vestry', ...args.map((arg, i) => i === reference ? pathArg(candidate) : shellArg(arg))].join(' ');
    if (values.color && !['auto', 'always', 'never'].includes(values.color)) throw usage(`Unknown color mode ${values.color}`, 'Use `--color auto`, `--color always`, or `--color never`.');
    terminal.configure({ mode: values['no-color'] ? 'never' : (values.color ?? 'auto') as ColorMode, quiet: values.quiet, home: values.home && homePath(values.home) });
    json = values.json ?? false; events = (values.events ?? false) && !json;
    if (values.events && values.json) throw usage('--json and --events can\'t be used together', 'Use `--json` for one result, or `--events` for progress as well.');
    if (values.help || !args.length || positionals[0] === 'help') {
      if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'help', help }));
      else if (events) emit('result', { command: 'help', result: { help } }); else terminal.help(help, positionals[0] === 'help' ? positionals[1] : positionals[0]);
      return 0;
    }
    const [command, ...inputs] = positionals;
    if (command === 'seal') throw usage('seal is kept for future metadata snapshots', 'Run `vestry create DRAFT --from-draft --output DIR` to package a draft.');
    if (!Object.hasOwn(allowed, command ?? '')) {
      const near = command ? closest(command) : undefined;
      throw usage(command ? `Unknown command ${command}` : 'No command given', near ? `Did you mean \`vestry ${near}\`?` : 'Run `vestry --help` to see the commands.');
    }
    for (const flag of Object.keys(values)) if (!common.includes(flag) && !allowed[command].includes(flag)) throw usage(`${command} doesn't take --${flag}`, `Run \`vestry ${command} --help\` to see its flags.`);
    if (command === 'cache') {
      if (!['add', 'list', 'pin', 'unpin', 'evict'].includes(inputs[0])) throw usage(inputs[0] ? `Unknown cache command ${inputs[0]}` : 'cache needs add, list, pin, unpin, or evict');
      if (inputs.length !== (inputs[0] === 'list' ? 1 : 2)) throw usage(inputs[0] === 'list' ? 'cache list takes no package' : `cache ${inputs[0]} needs one package`);
      if (values.pin !== undefined && inputs[0] !== 'add') throw usage('--pin works only with cache add');
      if (values.location && ['list', 'evict'].includes(inputs[0])) throw usage(`cache ${inputs[0]} doesn't take --location`);
    } else if (command === 'gather' ? inputs.length < 1 : ['cp', 'mv'].includes(command) ? inputs.length !== 2 : command === 'list' ? inputs.length !== 0 : ['history', 'recover'].includes(command) ? inputs.length > 1 : inputs.length !== 1) throw usage(command === 'gather' ? 'gather needs at least one path' : ['cp', 'mv'].includes(command) ? `${command} needs a package and a destination`
      : command === 'list' ? 'list takes no arguments' : inputs.length ? `${command} takes one ${takes[command] ?? 'package'}` : `${command} needs ${/^[aeiou]/i.test(takes[command] ?? '') ? 'an' : 'a'} ${takes[command] ?? 'package'}`);
    if (command === 'move' && !values.to?.trim()) throw usage('move needs --to DIR');
    if (command === 'move' && values.offline) throw usage('move doesn\'t work with --offline', 'The copy it moves has to be connected. Leave out `--offline`.');
    if (command === 'gather' && !values.into?.trim()) throw usage('gather needs --into DRAFT');
    if (values['zip-contents'] && values['keep-zip']) throw usage('--zip-contents and --keep-zip can\'t be used together', 'Use `--zip-contents` to package the files inside the ZIP, or `--keep-zip` to keep it as one file.');
    if (values['from-draft'] && (values['zip-contents'] || values['keep-zip'])) throw usage('--zip-contents and --keep-zip don\'t work with --from-draft');
    if (values.restart && (values.plan || values['from-draft'])) throw usage('--restart doesn\'t work with --plan or --from-draft');
    if (values['from-draft'] && !values.output?.trim()) throw usage('create --from-draft needs --output DIR', 'The draft stays as it is. Pass `--output` with the folder to make the package in.');
    if (values['from-draft'] && (values.description !== undefined || values.readme || values.as)) throw usage('create --from-draft doesn\'t take --description, --readme, or --as', 'The draft\'s notes go into the catalog. Run `vestry describe DRAFT` before packaging it, or `vestry edit` after.');
    if ((values.discard || values['release-lock']) && !inputs[0]) throw usage('--discard and --release-lock need an operation ID', 'Run `vestry recover` to see the unfinished operations.');
    if (values.discard && values['release-lock']) throw usage('--discard and --release-lock can\'t be used together');
    if (values['release-registry-lock'] && (inputs.length || values.discard || values['release-lock'])) throw usage('--release-registry-lock takes no operation ID or other recovery flag');
    if (values.output !== undefined && !values.output.trim()) throw usage('--output needs a folder');
    if (['eject', 'cp', 'mv', 'move', 'check', 'verify', 'inspect', 'pack', 'unpack', 'survey'].includes(command)) {
      try {
        const selected = await packageReference(inputs[0], { home: values.home, offline: values.offline, location: values.location });
        inputs[0] = selected.path;
      } catch (error) {
        const failure = diagnostic(error);
        if (failure.code !== 'AMBIGUOUS_COPY' || !process.stdin.isTTY || !process.stderr.isTTY || json || events || values.plan) throw error;
        const choices = failure.details.candidates as string[];
        const details = await locate(inputs[0], { home: values.home, offline: values.offline });
        const locations = details.locations as { path: string; representation: string; storage: string }[];
        inputs[0] = await chooseCopy(choices.map(path => {
          const location = locations.find(l => l.path === path);
          return { path, detail: [path === details.mainLocation ? 'main' : '', location?.representation, location?.storage === 'external' ? '' : location?.storage].filter(Boolean).join('  ') };
        }), { signal: controller.signal, color: colorEnabled(terminal.mode, true) });
      }
      // The selected path is now explicit; do not resolve --location a second time.
      values.location = undefined;
    }
    const inPlace = ['pack', 'unpack'].includes(command) && values.output === undefined;
    const source = inputs[0] ? resolve(inputs[0]) : undefined;
    if (command === 'create' && !values['from-draft'] && !values.plan && !values['zip-contents'] && !values['keep-zip'] && process.stdin.isTTY && process.stderr.isTTY && !json && !events) {
      const pendingCreate = !values.restart && (await listOperations({ home: values.home })).some(op => ['create', 'import-zip'].includes(op.kind) && op.source === source && !['succeeded', 'discarded'].includes(op.status));
      const singleZip = pendingCreate ? undefined : await singleZipDirectory(source!);
      if (singleZip) {
        const t = tokens(colorEnabled(terminal.mode, true));
        process.stderr.write(`This folder holds one ZIP, ${clean(singleZip)}.\n`);
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (await prompt.question(`${t.strong('Package the files inside it?')} ${t.muted('n keeps the ZIP as one file.')} [y/n] `, { signal: controller.signal })).trim().toLowerCase();
          if (!['y', 'yes', 'n', 'no'].includes(answer)) throw usage('No choice made', 'Pass `--zip-contents` or `--keep-zip`.');
          if (['y', 'yes'].includes(answer)) values['zip-contents'] = true;
          else values['keep-zip'] = true;
        } finally { prompt.close(); }
      }
    }
    const destination = (['cp', 'mv'].includes(command) ? inputs[1] : undefined) || values.output || values.into || values.to || (command === 'create' ? source : undefined);
    const context: Context & { offline?: boolean; location?: string } = { home: values.home, signal: controller.signal, offline: values.offline, location: values.location, quarantined,
      onActivity: (message, bytes, total) => {
        if (values.quiet) return;
        if (events && Date.now() - lastActivityEvent >= 500) { lastActivityEvent = Date.now(); emit('progress', { command, phase: 'activity', message, bytes, total }); }
        else if (!json && !events) terminal.activity(message, bytes, total);
      },
      // A scan says what it found, so the copy it's checking only shows as it goes.
      onRead: path => { if (!json && !events && !values.quiet) command === 'scan' ? terminal.activity(`Checking ${path}`) : terminal.reading(path); },
      onPhase: (phase, op) => { if (events && !values.quiet) emit('progress', { command, phase, operationId: op.id }); else if (!json && !events && !values.quiet) terminal.phase(phase, op); },
    };
    if (values.plan) {
      const creation = command === 'create' && !values['from-draft'] ? await creationPaths(source!, values.output, { zipContents: values['zip-contents'], keepZip: values['keep-zip'] }) : undefined;
      if (values['from-draft']) await readDraft(source!);
      const reads = ['move', 'mv', 'cp'].includes(command) ? [inputs[0]] : ['pack', 'unpack'].includes(command) ? [(await (inPlace ? conversionReference(inputs[0], context) : resolveReference(inputs[0], context))).path] : inputs.map(x => resolve(x));
      const result = { command, status: 'planned', reads, writes: [creation?.destination ?? (inPlace ? reads[0] : resolve(destination!)), homePath(values.home)],
        staging: 'A temporary folder beside the destination, checked and flushed to disk before publishing',
        scratch: creation?.zip ? (values.output ? 'One copy of the ZIP, unchanged, plus metadata. The source stays' : 'Metadata only: the ZIP is read where it is, then moved without copying') : values['from-draft'] && values.packed ? 'A copy of the draft\'s files, plus the ZIP made from them' : 'One complete copy, plus manifests and operation records',
        moves: creation?.zip && !values.output ? [{ from: creation.source, to: join(creation.destination, 'data.zip') }] : undefined,
        deletes: creation?.zip ? [] : (inPlace || command === 'create' && !values['from-draft']) ? ['The original folder, once its replacement is published and checked'] : values['from-draft'] && values.packed ? ['The staged files, once packed. The draft stays'] : [],
        retains: ['move', 'mv'].includes(command) ? 'The original, in a recovery folder until cleanup' : undefined,
        limitations: ['Space needs aren\'t estimated in bytes yet'] };
      if (json) console.log(JSON.stringify({ schemaVersion: 1, ...result }));
      else if (events) emit('result', { command, result }); else terminal.plan(result);
      return 0;
    }
    if (events && !values.quiet) emit('progress', { command, phase: 'started' });
    else if (!json && !events && !values.quiet && !['list', 'locate', 'history'].includes(command) && !(command === 'describe' && values.edit)) {
      const typed = positionals[command === 'cache' ? 2 : 1];
      terminal.start(`${command === 'cache' ? `cache ${inputs[0]}` : command}${typed ? ` ${typed}` : ''}`);
    }
    let result: Record<string, unknown>;
    switch (command) {
      case 'edit': result = await editMetadata(inputs[0], { ...(values.title !== undefined ? { title: values.title } : {}), ...(values.description !== undefined ? { description: values.description } : {}), ...(values.notes !== undefined ? { notes: await readFile(resolve(values.notes), 'utf8') } : {}) }, context); break;
      case 'create': result = values['from-draft'] ? await sealDraft(source!, values.output!, { ...context, packed: values.packed, catalogOnly: true }) : await createPackage(source!, { ...context, description: values.description, readme: values.readme, packed: values.packed, alias: values.as, output: values.output, restart: values.restart, zipContents: values['zip-contents'], keepZip: values['keep-zip'] }); break;
      case 'list': result = await listPackages(context); break;
      case 'scan': result = await scanDirectory(source!, { ...context, makeMain: values['make-main'], exports: true, onFound: finding => {
        if (events && !values.quiet) emit('progress', { command, phase: 'discovered', ...finding });
        else if (!json && !events && !values.quiet) terminal.found(finding.path, finding.discovery);
      } }); break;
      case 'forget': result = await forgetPackage(inputs[0], context); break;
      case 'cp': result = await copyArchive(inputs[0], inputs[1], context); break;
      case 'mv': result = await movePackage(inputs[0], inputs[1], context); break;
      case 'eject': result = await ejectPackage(inputs[0], { ...context, keepZip: values['keep-zip'] }); break;
      case 'cleanup': result = await cleanupMove(inputs[0], context); break;
      case 'show': {
        result = await locate(inputs[0], context);
        const available = (result.locations as { path: string; availability: string }[]).find(l => l.availability === 'available');
        if (available && await exists(join(available.path, 'README.txt'))) result.sealedReadme = await readFile(join(available.path, 'README.txt'), 'utf8');
        Object.assign(result, await surveyed(result.contentId as string, context));
        break;
      }
      case 'move': result = await movePackage(inputs[0], values.to!, context); break;
      case 'gather': result = await withPaths(inputs, context, () => gather(inputs, values.into!, context)); break;
      case 'describe': result = await describe(source!, { description: values.description, readme: values.readme, edit: values.edit }); break;
      case 'pack':
      case 'unpack': result = inPlace ? await convertInPlace(inputs[0], command === 'pack' ? 'packed' : 'expanded', { ...context, compress: values.compress, zip64: values.zip64 }) : await withReference(inputs[0], context, r => convertPackage(r.path, values.output!, command === 'pack' ? 'packed' : 'expanded', { ...context, expected: r.expected, compress: values.compress, zip64: values.zip64 })); break;
      case 'survey': result = await surveyPackage(inputs[0], { ...context, check: values.check, find: values.find }); break;
      case 'check':
      case 'verify': result = await withReference(inputs[0], context, r => verifyRecorded(r.path, { ...context, expected: r.expected })); break;
      case 'inspect': result = await withReference(inputs[0], context, async r => {
        const verified = await verifyRecorded(r.path, { ...context, expected: r.expected });
        return { ...await locate(verified.packageDigest as string, context), ...verified, identityConfidence: 'verified', sealedReadme: await exists(join(r.path, 'README.txt')) ? await readFile(join(r.path, 'README.txt'), 'utf8') : undefined };
      }); break;
      case 'register': result = await withReference(source!, context, async r => {
        const verified = await verifyRecorded(r.path, { ...context, expected: r.expected });
        await rememberVerified(r.path, verified as unknown as Verification, context, { alias: values.as });
        if (values.main) await adoptMain(r.path, verified.packageDigest as string, r.lease, context);
        return { ...verified, ...await locate(verified.packageDigest as string, context), status: 'registered', identityConfidence: 'verified' };
      }); break;
      case 'locate': result = await locate(inputs[0], context); break;
      case 'cache': result = inputs[0] === 'list' ? await cacheList(context) : inputs[0] === 'evict' ? await cacheEvict(inputs[1], context) : await cacheCopy(inputs[1], inputs[0] as 'add' | 'pin' | 'unpin', { ...context, pin: values.pin }); break;
      case 'history': {
        let id: string | undefined;
        let locations: string[] = [];
        if (inputs[0]) {
          const state = await readRegistry(context);
          id = Object.values(state.packages).find(p => p.locations.some(l => l.path === source))?.packageDigest;
          if (!id) { try { id = contentRecords(inputs[0], state)[0].packageDigest; } catch (e) { if (diagnostic(e).exitCode !== 4 || (!inputs[0].includes('/') && !inputs[0].startsWith('.'))) throw e; } }
          if (id) locations = Object.values(state.packages).filter(r => r.payloadDigest === state.packages[id!].payloadDigest).flatMap(r => r.locations.map(l => l.path));
        }
        result = { operations: (await listOperations(context)).filter(op => !source || op.source === source || op.destination === source || id && (op.expected === id || op.ejectPackageDigest === id) || locations.includes(op.source) || op.destination && locations.includes(op.destination)) }; break;
      }
      case 'recover': result = values['release-registry-lock'] ? await releaseRegistryLock(context) : inputs[0] ? await recover(inputs[0], checkOutput, context, values.discard, values['release-lock']) : { operations: (await listOperations(context)).filter(op => !['succeeded', 'discarded'].includes(op.status)) }; break;
      default: throw usage('Unknown command');
    }
    controller.signal.throwIfAborted();
    if (result.cleanupRequired && values.home) result.cleanupHome = homePath(values.home);
    if (quarantined.length) {
      result.quarantined = quarantined;
      result.warnings = [...new Set([...(result.warnings ?? []) as string[], ...quarantined.flatMap(report => report.warnings)])];
    }
    terminal.stopActivity();
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command, ...result }));
    else if (events) emit('result', { command, result });
    else terminal.result(command, result, command === 'cache' ? inputs[0] : undefined);
    for (const warning of (result.warnings ?? []) as string[]) json || events ? console.error(`vestry: ${warning}`) : terminal.warn(warning);
    return ['scan', 'survey'].includes(command) ? result.exitCode as number : 0;
  } catch (error) {
    terminal.stopActivity();
    const failure = diagnostic(controller.signal.aborted ? controller.signal.reason : error);
    const detail = { code: failure.code, message: failure.message, ...(failure.hint && { hint: failure.hint }), ...failure.details, ...(quarantined.length ? { quarantined } : {}) };
    if (json) console.log(JSON.stringify({ schemaVersion: 1, error: detail }));
    else if (events) emit('error', { error: detail });
    else terminal.error(activeCommand, failure, quarantined, retry);
    return failure.exitCode;
  } finally { terminal.stopActivity(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
