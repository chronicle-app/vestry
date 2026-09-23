import type { Operation, Phase } from './operations.js';

export type ColorMode = 'auto' | 'always' | 'never';
type Result = Record<string, any>;
const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const quote = (value: unknown) => `'${String(value).replaceAll("'", "'\\''")}'`;
const shortId = (id: unknown) => String(id ?? '').split(':').at(-1)!.slice(0, 12);
const readable = (value: unknown) => clean(value).replaceAll('-', ' ');

export function colorEnabled(mode: ColorMode, tty: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode !== 'auto') return mode === 'always';
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return tty && env.TERM !== 'dumb';
}
export function formatBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return clean(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const power = n ? Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1) : 0;
  return `${(n / 1024 ** power).toLocaleString('en-US', { maximumFractionDigits: power ? 1 : 0 })} ${units[power]}`;
}
const descriptions: Record<string, string> = {
  eject: 'Restore payload files to the package folder, retaining the original package for recovery.',
  edit: 'Update catalog title, description, or notes without changing package bytes.',
  show: 'Show a package description and all known copies; does not check integrity.',
  check: 'Read the selected copy and verify its integrity.',
  cp: 'Copy to a new package path, verify the copy, and keep the original.',
  mv: 'Relocate a package; retain the original in a recovery folder until explicit cleanup.',
  cleanup: 'Recheck a moved package and remove its retained original. Frees source disk space.',
  create: 'Create a package from a folder in place, or turn an existing ZIP into a packed package.',
  list: 'Show packages and counts of available and missing copies.',
  scan: 'Find and verify packages in a directory tree, then register their locations.',
  inspect: 'Verify the selected copy and show its description, identity, and locations.',
  verify: 'Read and checksum every payload file and tag. Reports full verification.',
  pack: 'Replace data/ with data.zip at the same package location. Identity stays unchanged.',
  unpack: 'Replace data.zip with data/ at the same package location. Identity stays unchanged.',
  move: 'Compatibility spelling of mv PACKAGE DESTINATION (with --to DESTINATION).',
  register: 'Verify an existing package and remember its location. Optionally add an alias.',
  forget: 'Remove registration and all aliases. Files, managed copies, and history are retained.',
  locate: 'Show known locations and availability. This does not reverify package contents.',
  history: 'Show recorded operations, including failures and interruptions.',
  recover: 'List unfinished operations, or resume a specific operation from verified staging.',
  cache: 'Keep verified local copies available while your archive is offline.',
  gather: 'Copy original files into a new editable draft. Originals stay untouched.',
  describe: 'Edit a draft description or README before sealing it.',
  seal: 'Reserved for future metadata snapshots. For drafts, use create DRAFT --from-draft --output DIR.',
};

export class Terminal {
  private started = Date.now();
  private seen = new Set<string>();
  private ticker?: ReturnType<typeof setInterval>;
  private activityText = 'Preparing; checking source and destination…';
  private activityBytes?: string;
  private activityTotal?: string;
  private frame = 0;
  private lastLog = 0;
  private clearActivity() {
    if (this.ticker && process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
  }
  activity(message: string, bytes?: string, total?: string) {
    this.activityText = clean(message).replace(/[\r\n\t]/g, ' ');
    this.activityBytes = bytes; this.activityTotal = total;
  }
  private renderActivity() {
    const elapsed = Math.floor((Date.now() - this.started) / 1000);
    const timing = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed`;
    const amounts = this.activityBytes === undefined ? '' : ` · ${formatBytes(this.activityBytes)} / ${formatBytes(this.activityTotal)}`;
    const suffix = amounts + ` · ${timing}`;
    if (process.stderr.isTTY) {
      const width = Math.max(20, (process.stderr.columns || 100) - 5 - suffix.length);
      const label = this.activityText.length > width ? '…' + this.activityText.slice(-Math.max(1, width - 1)) : this.activityText;
      process.stderr.write(`\r\x1b[2K  ${['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][this.frame++ % 10]} ${label}${suffix}`);
    } else if (!this.lastLog || Date.now() - this.lastLog >= 10000) {
      console.error(`  › ${this.activityText}${suffix}`); this.lastLog = Date.now();
    }
  }
  stopActivity() {
    this.clearActivity();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
  constructor(public mode: ColorMode = 'auto') {}
  private style(text: string, code: string, error = false): string {
    return colorEnabled(this.mode, !!(error ? process.stderr.isTTY : process.stdout.isTTY)) ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
  private heading(text: string, tone = '36', error = false): string { return this.style(clean(text), `1;${tone}`, error); }
  private width() { return Math.max(36, Math.min(process.stdout.columns || 100, 110)); }
  private wrap(value: unknown, indent: number): string {
    const width = this.width() - indent;
    return clean(value).split('\n').flatMap(line => {
      const lines: string[] = [];
      while (line.length > width) {
        let cut = line.lastIndexOf(' ', width);
        if (cut < width / 2) { lines.push(line); return lines; }
        lines.push(line.slice(0, cut)); line = line.slice(cut).replace(/^ +/, '');
      }
      return [...lines, line];
    }).join('\n' + ' '.repeat(indent));
  }
  private row(label: string, value: unknown): string {
    if (value === undefined || value === null || value === '') return '';
    return `  ${this.style(label.padEnd(12), '2')} ${this.wrap(value, 15)}\n`;
  }
  private contents(result: Result): string {
    if (result.payloadFiles === undefined || result.payloadBytes === undefined) return this.row('Contents', 'Not recorded yet · run vestry check PACKAGE');
    return this.row('Files', Number(result.payloadFiles).toLocaleString('en-US')) + this.row('Size', `${formatBytes(result.payloadBytes)} · original files (uncompressed)`);
  }
  private availability(value: unknown): string {
    const good = ['available', 'succeeded', 'verified', 'known'].includes(String(value));
    const bad = ['changed', 'failed', 'unavailable'].includes(String(value));
    return this.style(readable(value), good ? '32' : bad ? '31' : '33');
  }
  start(command: string, ref?: string, mode?: string) {
    this.started = Date.now();
    console.error(`\n${this.heading(`VESTRY  /  ${command}`, '36', true)}`);
    if (ref) console.error(`  Reference    ${clean(ref)}`);
    if (mode) console.error(`  Mode         ${clean(mode)}`);
    this.ticker = setInterval(() => this.renderActivity(), 100);
    this.ticker.unref();
    this.renderActivity();
  }
  reading(path: string) { this.progress(`Checking checksums  ${path}`); }
  found(path: string, discovery: string) { this.progress(`${readable(discovery)}  ${path}`); }
  private progress(message: string) {
    this.activity(message);
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.clearActivity();
    console.error(`  ${this.style('›', '36', true)} ${clean(message)}`);
  }
  phase(phase: Phase, op: Operation) {
    if (phase === 'planned') {
      this.progress(`Source  ${op.source}`);
      if (op.destination && op.destination !== op.source) this.progress(`Destination  ${op.destination}`);
    }
    const building = op.kind === 'pack' ? 'Packing payload and checking the replacement…' : op.kind === 'unpack' ? 'Expanding payload and checking the replacement…' : op.kind === 'import-zip' ? 'Reading ZIP and preparing its package…' : 'Building and checking the staged copy…';
    const labels: Partial<Record<Phase, string>> = { building, verified: op.zipAdoption ? 'ZIP inventory and manifests prepared; preparing publication…' : 'Staged copy verified; preparing publication…', relocated: op.zipAdoption ? 'Original ZIP moved into staging unchanged; verifying package…' : 'Original retained in a recovery backup.', published: 'Replacement published.', cleaning: 'Removing the verified old copy…' };
    if (labels[phase]) this.progress(labels[phase]!);
  }
  help(help: string, command?: string) {
    let out = `\n${this.heading(command ? `VESTRY  /  ${command}` : 'VESTRY')}\n`;
    if (command && descriptions[command]) {
      out += `\n  ${this.wrap(descriptions[command], 2)}\n\n${this.heading('Usage')}\n`;
      out += help.split('\n').filter(line => line.startsWith(`  vestry ${command} `) || line === `  vestry ${command}`).join('\n') + '\n';
      if (['pack', 'unpack'].includes(command)) out += '\n  Default: convert the selected copy in place. Run from outside the package.\n  --output DIR creates a separate copy; --location PATH selects another copy.\n  Allow space for both representations until verification finishes.\n';
      if (['cp', 'mv', 'move'].includes(command)) out += '\n  DESTINATION is the exact new package path; it must not exist.\n  Its parent directory must exist. No automatic directory nesting.\n  mv retains a recovery copy; use cleanup OPERATION-ID to free that space.\n';
      if (command === 'eject') out += '\n  Default: restore logical files; packed packages are extracted.\n  --keep-zip restores data.zip without extraction using its recorded name,\n  or payload.zip if unknown. Run outside the package.\n  Original package retained until cleanup OPERATION-ID.\n';
      if (command === 'cleanup') out += '\n  Deletes only the recorded recovery copy of a completed mv or eject operation.\n  Rechecks destination identity and disk flushes first; refuses durability warnings.\n';
      if (command === 'edit') out += '\n  --title TEXT, --description TEXT, --notes FILE update catalog records only.\n  Empty text clears a field. Back up Vestry records to preserve these notes.\n';
      if (command === 'create') out += '\n  Retry create PATH to resume an interrupted creation.\n  --restart discards owned temporary work and rebuilds from the retained original.\n  Single-ZIP folders prompt: use ZIP contents or preserve the ZIP as one file.\n  Scripts: --zip-contents or --keep-zip. No ZIP extraction to disk is needed.\n  No description required. --description and --readme store editable catalog metadata.\n  Folder: sealed at the same path. ZIP: moved unchanged into a sibling package.\n  --output DIR copies the ZIP to another package and retains the source. --as NAME adds an alias.\n  --from-draft --output DIR packages a draft and imports its notes into the catalog.\n';
      if (command === 'recover') out += '\n  No ID: list pending work. With ID: resume verified staging.\n  --discard discards owned incomplete staging.\n  --release-lock / --release-registry-lock check a dead owner before unlocking.\n';
      if (command === 'register') out += '\n  --as NAME adds an alias. --main makes this the main archive location.\n';
      if (command === 'scan') out += '\n  Recursively checks candidates containing bagit.txt; never descends into payloads.\n  Existing main locations are retained. --make-main adopts unique discovered copies.\n  Duplicate copies require an explicit choice with register PATH --main.\n  Symlinks, drafts, Vestry storage, and recovery staging are skipped.\n  Exit 1 means some candidates failed or a main location was ambiguous.\n';
      if (command === 'describe') out += '\n  --edit opens $VISUAL or $EDITOR. --readme FILE imports notes.\n  --description TEXT sets the short description.\n';
    } else {
      out += '\n  Preserve files. Know where they live. Verify them anytime.\n';
      const groups = [
        ['Everyday commands', ['create', 'list', 'show', 'edit', 'check', 'scan', 'pack', 'unpack', 'cp', 'mv', 'eject', 'forget']],
      ] as const;
      for (const [title, commands] of groups) {
        out += `\n${this.heading(title)}\n`;
        for (const c of commands) {
          const usage = help.split('\n').find(line => line.startsWith(`  vestry ${c} `) || line === `  vestry ${c}`)!.split(' [')[0].replace('create DIR', 'create PATH');
          out += `${this.style(usage, '1')}\n    ${this.wrap(descriptions[c], 4)}\n`;
        }
      }
      out += '\n  Advanced: cleanup, history, recover, register, cache, gather, describe.\n  Draft packaging: vestry create DRAFT --from-draft --output DIR.\n  Reserved for future revisions: seal, status, checkout, commit.\n  Compatibility: verify (check), inspect, locate, move PACKAGE --to DESTINATION.\n  A package detects damage. A separate copy helps you recover from it.\n';
      out += '\n  vestry COMMAND --help   Options and behavior for a command\n';
    }
    out += `\n${this.heading('Common options')}\n  --home DIR      Use separate Vestry records (normally automatic)\n  --plan          Preview create/cp/mv/pack/unpack and preparation without writing\n  --offline       Resolve reads through managed local copies\n  --quiet         Hide routine progress; keep results and errors\n  --color MODE    auto, always, never (also respects NO_COLOR)\n  --json          One machine-readable result; no ANSI formatting\n  --events        NDJSON progress and result; no ANSI formatting\n\n  PACKAGE = path, full digest, or unambiguous digest prefix (aliases still work).\n  Multiple available copies: choose interactively, or use a path in scripts.\n`;
    console.log(out);
  }
  plan(result: Result) {
    let out = `\n${this.heading(`PLAN  /  ${result.command}`)}\n\n  Preview only. No files changed.\n\n`;
    for (const path of result.reads) out += this.row('Read', path);
    for (const [index, path] of result.writes.entries()) out += this.row(index === result.writes.length - 1 ? 'Records' : 'Package', path);
    out += '\n' + this.row('Staging', result.staging) + this.row('Space', result.scratch);
    for (const move of result.moves ?? []) out += this.row('Move', `${move.from} → ${move.to}`);
    out += this.row('Retain', result.retains);
    out += this.row('Remove', result.deletes.length ? result.deletes.join('\n') : 'Nothing');
    for (const note of result.limitations) out += this.row('Note', note);
    console.log(out);
  }
  private quarantine(reports: Result[] = []) {
    let out = '';
    for (const report of reports) {
      out += `\n${this.heading('Finder metadata preserved', '33')}\n`;
      out += this.row(report.copyOnly ? 'Files saved' : 'Files moved', report.files.length) + this.row('Quarantine', report.directory);
      for (const file of report.files) out += this.row('File', file);
    }
    return out;
  }
  result(command: string, result: Result, subcommand?: string) {
    let out = '\n';
    if (command === 'scan') {
      out += `${this.heading(result.issues.length ? 'SCAN  /  completed with issues' : 'SCAN  /  complete', result.issues.length ? '33' : '32')}\n\n`;
      out += this.row('Directory', result.root) + this.row('Results', `${result.summary.verified} verified copies · ${result.summary.packages} packages · ${result.summary.newPackages} new`);
      out += this.row('Changes', `${result.summary.mainLocationsSet} main locations set · ${result.summary.possibleMoves} possible moves`);
      if (!result.summary.candidates) out += '\n  No package candidates found. Ordinary folders and loose ZIPs are not packages.\n';
      for (const finding of result.findings) {
        out += `\n  ${this.heading(readable(finding.discovery).toUpperCase())}  ${shortId(finding.contentId ?? finding.packageDigest)}\n`;
        out += this.row('Found', finding.path) + this.row('Main', finding.mainLocation ?? 'Not designated') + this.row('Main change', finding.mainAction);
        if (finding.discovery === 'possible-move') out += this.row('Note', 'Previous main location is missing. It may be disconnected; no move is assumed.');
      }
      for (const issue of result.issues) {
        out += `\n${this.heading(issue.code === 'AMBIGUOUS_MAIN_LOCATION' ? 'Choose a main location' : 'Could not verify or register', '33')}\n`;
        out += this.row('Path', issue.path) + this.row('Reason', issue.message);
        for (const path of issue.candidates ?? []) out += this.row('Copy', path);
      }
      if (result.skipped.length) {
        out += `\n${this.heading('Skipped')}\n`;
        for (const skip of result.skipped) out += this.row('Path', skip.path) + this.row('Reason', skip.reason);
      }
      if (result.summary.possibleMoves || result.issues.some((i: Result) => i.code === 'AMBIGUOUS_MAIN_LOCATION')) out += '\n  Choose a specific main copy: vestry register PATH --main\n';
    } else if (Array.isArray(result.packages)) {
      out += `${this.heading(`PACKAGES  /  ${result.packages.length}`)}\n`;
      if (!result.packages.length) out += '\n  Nothing registered yet.\n  Start with: vestry create ./folder --description "What this contains"\n';
      for (const pkg of result.packages) {
        const id = shortId(pkg.contentId ?? pkg.packageDigest);
        out += `\n  ${this.style(clean(pkg.aliases?.join(', ') || id), '1')}  ${this.availability(pkg.copyAvailability ?? pkg.availability)}\n`;
        out += this.row('Content ID', pkg.contentId ?? pkg.packageDigest) + this.contents(pkg) + this.row('Copies', pkg.copySummary);
        const copies = (pkg.locations ?? []).filter((location: Result) => location.state !== 'evicted');
        for (const [index, location] of copies.entries()) {
          const branch = index === copies.length - 1 ? '└─' : '├─';
          out += `    ${branch} ${this.style(clean(location.path), '1')}\n`;
          const labels = [location.path === pkg.mainLocation ? 'MAIN' : undefined, this.availability(location.availability), clean(location.representation), location.storage === 'external' ? undefined : clean(location.storage)].filter(Boolean);
          out += `       ${labels.join(' · ')}\n`;
        }
        if (!pkg.mainLocation) out += '       No main copy designated\n';
      }
    } else if (Array.isArray(result.operations)) {
      out += `${this.heading(command === 'recover' ? 'RECOVERY' : 'HISTORY')}  ${result.operations.length} operation(s)\n`;
      if (!result.operations.length) out += command === 'recover' ? '\n  No pending operations.\n' : '\n  No matching operation records.\n';
      for (const op of result.operations) {
        out += `\n  ${this.style(clean(op.kind), '1')}  ${this.availability(op.status)}  ${this.style(clean(op.startedAt), '2')}\n`;
        out += this.row('Operation', op.id) + this.row('Stage', op.phase) + this.row('Source', op.source);
        if (op.destination && op.source !== op.destination) out += this.row('Destination', op.destination);
        if (op.retainOriginal && !op.sourceRetired && op.result?.cleanupRequired) out += this.row('Recovery copy', op.backup) + this.row('Cleanup', `vestry cleanup ${op.id} (use the same --home, if supplied)`);
        if (op.error) out += this.row('Error', op.error.message);
      }
      if (command === 'recover' && result.operations.length) out += '\n  Resume: vestry recover OPERATION-ID (use the same --home, if supplied)\n';
    } else if (Array.isArray(result.copies)) {
      out += `${this.heading(`LOCAL COPIES  /  ${result.copies.length}`)}\n`;
      if (!result.copies.length) out += '\n  No managed copies. Keep one with: vestry cache add REF --pin\n';
      for (const copy of result.copies) out += `\n  ${this.style(copy.pinned ? 'PINNED' : 'DISPOSABLE', '1')}  ${this.availability(copy.availability)}\n` + this.row('Content ID', copy.contentId) + this.row('Package digest', copy.packageDigest) + this.row('Location', copy.path) + this.row('Format', copy.representation);
    } else {
      const titles: Record<string, string> = { eject: 'Package ejected', edit: 'Vestry metadata updated', show: 'Package details', check: 'Integrity verified', cp: 'Package copied', mv: 'Package relocated', cleanup: 'Recovery copy cleaned up', create: 'Package created', seal: 'Package sealed', pack: 'Package packed', unpack: 'Package expanded', move: 'Package moved', register: 'Package registered', verify: 'Integrity verified', inspect: 'Package inspected', locate: 'Known locations', forget: 'Package forgotten', gather: 'Draft created', describe: 'Description updated', cache: subcommand === 'evict' ? 'Cached copy evicted' : subcommand === 'unpin' ? 'Copy unpinned' : result.pinned ? 'Offline copy pinned' : 'Local copy ready', recover: readable(result.status ?? 'Recovery complete') };
      const factual = ['locate', 'show'].includes(command) || result.status === 'interrupted';
      out += `${this.heading(`${factual ? '•' : '✓'} ${titles[command] ?? 'Complete'}`, factual ? '36' : '32')}  ${this.style(`${((Date.now() - this.started) / 1000).toFixed(1)}s`, '2')}\n\n`;
      out += this.row('Location', result.path) + this.row('Main', result.mainLocation !== result.path ? result.mainLocation : undefined);
      out += this.row('Format', result.representation === 'packed' ? 'Packed · data.zip' : result.representation === 'expanded' ? 'Expanded · data/' : undefined);
      if (['show', 'locate', 'inspect'].includes(command)) out += this.contents(result);
      else if (result.payloadFiles !== undefined) out += this.row('Contents', `${Number(result.payloadFiles).toLocaleString('en-US')} files · ${formatBytes(result.payloadBytes)} logical payload`);
      if (result.aliases?.length) out += this.row('Aliases', result.aliases.join(', '));
      out += this.row('Content ID', result.contentId ?? result.payloadDigest);
      if (['show', 'inspect', 'check', 'verify'].includes(command)) out += this.row('Package digest', result.packageDigest);
      if (result.identityConfidence === 'expected') out += this.row('Identity', 'Expected from records; not reverified by this lookup');
      if (result.storage) out += this.row('Storage', result.storage === 'pinned' ? 'Pinned · retained until explicitly unpinned' : result.storage === 'cache' ? 'Disposable cache' : result.storage);
      if (result.locations?.length) {
        out += `\n${this.heading('Copies')}\n`;
        for (const location of result.locations) out += `\n  ${this.style(location.path === result.mainLocation ? 'MAIN' : clean(location.storage).toUpperCase(), '1')}  ${this.availability(location.availability)}\n` + this.row('Path', location.path) + this.row('Package digest', location.packageDigest) + this.row('Format', location.representation) + this.row('Last checked', location.lastVerifiedAt);
      }
      if (result.metadata) out += `\n${this.heading('Vestry metadata (editable)')}\n` + this.row('Title', result.metadata.title) + this.row('Description', result.metadata.description) + this.row('Notes', result.metadata.notes);
      if (new Set((result.metadataVariants ?? []).map((v: Result) => JSON.stringify([v.metadata?.title, v.metadata?.description, v.metadata?.notes]))).size > 1) out += '\n  Copies have differing catalog metadata; inspect --json for all recorded values.\n';
      if (result.sealedReadme) out += `\n${this.heading('Sealed description (in package)')}\n  ${this.wrap(String(result.sealedReadme).trimEnd(), 2)}\n`;
      if (result.readme) out += `\n${this.heading('Description')}\n  ${this.wrap(String(result.readme).trimEnd(), 2)}\n`;
      if (result.message) out += `\n  ${this.wrap(result.message, 2)}\n`;
      if (result.sourceMoved) out += '\n  Original ZIP moved unchanged into the package as data.zip; no archive copy.\n';
      if (result.sourceRetained) out += command === 'create' ? '\n  Source ZIP retained unchanged.\n' : '\n  Original package retained.\n';
      if (result.cleanupRequired) out += '\n' + this.row('Recovery copy', result.recoveryCopy) + '\n  Original retained; source disk space has not been freed.\n  Remove it after rechecking the destination:\n    vestry cleanup ' + clean(result.operationId) + (result.cleanupHome ? ' --home ' + clean(quote(result.cleanupHome)) : '') + '\n';
      if (['pack', 'unpack'].includes(command)) out += '\n  Package identity and descriptive metadata preserved.\n';
      if (result.timings?.length) {
        out += `\n${this.heading('Stage timings')}\n`;
        for (const timing of result.timings) out += this.row(`${Number(timing.seconds).toFixed(1)}s`, timing.stage);
      }
      if (result.operationId) out += '\n' + this.row('Operation', result.operationId);
    }
    out += this.quarantine(result.quarantined);
    console.log(out);
  }
  error(command: string, failure: { code: string; message: string; exitCode: number; details: Result }, reports: Result[] = []) {
    const titles: Record<number, string> = { 2: 'Check the command', 3: 'Integrity check failed', 4: 'Package or resource unavailable', 5: 'Operation could not proceed', 130: 'Operation interrupted' };
    let out = `\n${this.heading(`✗ ${titles[failure.exitCode] ?? 'Operation failed'}`, '31', true)}\n\n  ${clean(failure.message)}\n`;
    out += `\n  Code         ${clean(failure.code)}\n`;
    if (failure.details.operationId) {
      out += `  Operation    ${clean(failure.details.operationId)}\n\n  Inspect pending work:\n    vestry recover${failure.details.home ? ` --home ${clean(quote(failure.details.home))}` : ''}\n`;
    } else if (failure.exitCode === 2) out += `\n  Usage: vestry ${clean(command)} --help\n`;
    if (failure.details.candidates) out += '\n  Matching packages or copies:\n' + failure.details.candidates.map((c: unknown) => `    ${clean(c)}\n`).join('');
    out += this.quarantine(reports);
    console.error(colorEnabled(this.mode, !!process.stderr.isTTY) ? out : out.replace(/\x1b\[[0-9;]*m/g, ''));
  }
}
