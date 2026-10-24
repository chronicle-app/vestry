import { createLogger, type Logger, type Sink } from '@chronicle.app/logging';
import type { Operation, Phase } from './operations.js';
import packageInfo from '../package.json' with { type: 'json' };
import { COMMANDS, EVERYDAY, GLOBAL_FLAGS, MORE, type Flag } from './help.js';
import {
  bytes, card, clean, colorEnabled, createSink, count, date, day, definitions, glyphs, heading, hint, line, paragraph, pathArg, plural, relativePath, summary, table, tilde, tildes, tokens,
  type ColorMode, type ProgressFields, type Segment, type Status, type Style, type Tokens,
} from './output/index.js';

export { colorEnabled, type ColorMode } from './output/index.js';

type Result = Record<string, any>;

const shortId = (id: unknown) => String(id ?? '').split(':').at(-1)!.slice(0, 12);
const readable = (value: unknown) => clean(value).replaceAll('-', ' ');
/** A path as a person reads it, safe to print. */
const where = (path: unknown) => tilde(clean(path));
/** A path in a line about what's happening: from here, when it's below here. */
const here = (path: unknown) => relativePath(clean(path));
/** When something happened, in local time to the minute. */
const when = (iso: unknown) => iso ? date(new Date(String(iso))) : 'never';
/** Where an export starts in the payload, the same for every copy and form. */
const exportRoot = (root: unknown) => `data/${clean(root)}`;
const format = (representation: unknown) => representation === 'packed' ? 'packed (data.zip)' : representation === 'expanded' ? 'expanded (data/)' : undefined;
const contents = (result: Result) => result.payloadFiles === undefined ? undefined
  : `${count(Number(result.payloadFiles))} ${plural('files', Number(result.payloadFiles))}, ${bytes(result.payloadBytes)}`;
/** What a package is called: its aliases, or the start of its Content ID. */
const named = (result: Result) => clean(result.aliases?.join(', ') || shortId(result.contentId ?? result.payloadDigest ?? result.packageDigest));
/** A local date for a cell, like 2026-07-15, or - for none. */
const dayOf = (iso: unknown) => iso ? day(new Date(String(iso))) : '-';
/** A local date and time to the minute, as two cells. */
const stamp = (iso: unknown) => iso ? date(new Date(String(iso))).split(' ') : ['-', '-'];
/** A value as one cell, or - for none. */
const cell = (value: unknown) => clean(value) || '-';
/** Whether a copy is there, in a word; with --offline, an external copy isn't looked at. */
const state = (availability: unknown) => availability === 'not-checked-offline' ? 'unchecked' : cell(availability);
/** What a copy is to its package: the main copy, another copy, or one in Vestry's cache. */
const role = (location: Result, main: unknown) => location.path === main ? 'main' : location.storage && location.storage !== 'external' ? clean(location.storage) : 'copy';
/** The copies a package still has. */
const kept = (locations: Result[]) => locations.filter(location => location.state !== 'evicted' && location.availability !== 'evicted');
/** Paths padded to a column, unless one is so long the rest would trail off after it. */
const column = (texts: string[]) => {
  const widest = Math.max(0, ...texts.map(text => text.length));
  return texts.map(text => widest <= 60 ? text.padEnd(widest) : text);
};
/** How a copy's availability looks: its glyph, and a word for anything but available. */
function availability(value: unknown, t: Tokens): [Segment, ...Segment[]] {
  if (value === 'available') return [[glyphs.success, t.success]];
  if (['unavailable', 'changed', 'failed'].includes(String(value))) return [[glyphs.failure, t.danger], [`  ${readable(value)}`, t.danger]];
  if (value === 'not-checked-offline') return [[glyphs.bullet, t.muted], ['  not checked offline', t.muted]];
  return [[glyphs.warning, t.warning], [`  ${readable(value)}`, t.warning]];
}
/** A measure as one word, like conversations=482 or calls=12h. */
function measure(m: Result): string {
  const value = Number(m.value), hours = value / 3600;
  const shown = m.unit === 'bytes' ? bytes(value).replace(' ', '') : m.unit === 'seconds' ? (hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(value / 60)}m`) : String(value);
  return `${clean(m.label ?? m.key).replaceAll(' ', '-')}=${shown}`;
}

/** What a result that reports something done is titled. */
function title(command: string, result: Result, subcommand?: string): string {
  if (command === 'recover') return result.status === 'lock-released' ? 'Lock released' : result.status === 'discarded' ? 'Operation discarded' : result.status === 'interrupted' ? 'Operation still unfinished' : 'Operation recovered';
  if (command === 'cache') return subcommand === 'evict' ? 'Cached copy evicted' : subcommand === 'unpin' ? 'Copy unpinned' : result.pinned ? 'Offline copy pinned' : 'Local copy ready';
  const titles: Record<string, string> = {
    eject: 'Package ejected', edit: 'Catalog updated', check: 'Integrity verified', verify: 'Integrity verified', inspect: 'Integrity verified',
    cp: 'Package copied', mv: 'Package moved', move: 'Package moved', cleanup: 'Recovery copy removed', create: 'Package created', seal: 'Package sealed',
    pack: 'Package packed', unpack: 'Package unpacked', register: 'Package registered', forget: 'Package forgotten', gather: 'Draft created', describe: 'Description updated',
  };
  return titles[command] ?? 'Done';
}

/** What an operation is about to do, for the log. */
function planned(op: Operation): string | undefined {
  const [from, to] = [here(op.source), here(op.destination)];
  const inPlace = op.inPlace || op.destination === op.source;
  switch (op.kind) {
    case 'create': return inPlace ? `Packaging ${from} in place` : `Packaging ${from} as ${to}`;
    case 'import-zip': return `Packaging ${from} as ${to}`;
    case 'seal': return `Packaging the draft ${from} as ${to}`;
    case 'copy': return `Copying ${from} to ${to}`;
    case 'move': return `Moving ${from} to ${to}`;
    case 'pack': return inPlace ? `Packing ${from} in place` : `Packing ${from} into ${to}`;
    case 'unpack': return inPlace ? `Unpacking ${from} in place` : `Unpacking ${from} into ${to}`;
    case 'eject': return `Ejecting ${from}`;
    case 'cache-copy': return `Copying ${from} to the cache`;
    case 'gather': return `Gathering files into ${to}`;
    default: return undefined;
  }
}

/** How each flag is typed, the long forms lined up when any flag has a short one: `-q, --quiet`, `    --home DIR`. */
function flagTerms(flags: Flag[], t: Tokens) {
  const pad = flags.some(([name]) => name.includes(', '));
  return flags.map(([name, value, text]) => ({
    term: [[`${pad && !name.includes(', ') ? '    ' : ''}${name}`, t.command], ...(value ? [[` ${value}`, t.muted]] : [])] as Segment[],
    text,
  }));
}

export interface Failure { code: string; message: string; exitCode: number; details: Result; hint?: string }

/**
 * How vestry talks to a person: results on stdout, and everything else as
 * `@chronicle.app/logging` events, rendered on stderr by a pretty or plain sink.
 */
export class Terminal {
  /** The `--home` a person passed: added to the vestry commands in hints, so they run as printed. */
  home?: string;
  quiet = false;
  private started = Date.now();
  private seen = new Set<string>();
  private output?: { sink: Sink; logger: Logger };
  private progress?: ProgressFields;

  constructor(public mode: ColorMode = 'auto') {}

  /** Take the flags that shape output, once they're parsed. */
  configure({ mode, quiet, home }: { mode: ColorMode; quiet?: boolean; home?: string }) {
    this.output?.sink.flush?.();
    this.output = undefined;
    Object.assign(this, { mode, quiet: !!quiet, home });
  }

  /**
   * Where a person's messages go: a pretty sink at a terminal, plain lines
   * otherwise. `--quiet` keeps warnings and errors.
   */
  private get log(): Logger {
    if (!this.output) {
      const sink = createSink({ pretty: !!process.stderr.isTTY, t: tokens(colorEnabled(this.mode, !!process.stderr.isTTY)), level: this.quiet ? 'warn' : 'info' });
      this.output = { sink, logger: createLogger({ scope: 'cli', sink }) };
    }
    return this.output.logger;
  }
  /** Colors for a result on stdout. */
  private get t(): Tokens { return tokens(colorEnabled(this.mode, !!process.stdout.isTTY)); }
  /** Columns a result fits: the terminal's, or unbounded when piped, so nothing is cut. */
  private get width(): number { return process.stdout.isTTY ? (process.stdout.columns || 80) - 1 : Number.POSITIVE_INFINITY; }
  private print(lines: string[]) { if (lines.length) process.stdout.write(`${lines.join('\n')}\n`); }

  /**
   * A hint's text made safe to print, since its paths and Chronicle's hints
   * come from outside, and with `--home` added to each vestry command in it,
   * so the command finds the same catalog.
   */
  private next(text: string): string {
    text = clean(text);
    if (!this.home) return text;
    return text.replaceAll(/`(vestry [^`]*)`/g, (span, command: string) => /--home|--help/.test(command) ? span : `\`${command} --home ${pathArg(this.home!)}\``);
  }
  private hint(text: string): string[] { return hint(this.next(text), this.t, this.width); }

  /** A command under way: a live line at a terminal, a heartbeat in a log. */
  start(title: string) {
    this.started = Date.now();
    this.progress = { title: clean(title).replace(/[\r\n\t]/g, ' '), elapsedMs: 0 };
    this.log.emit({ level: 'debug', kind: 'progress', message: this.progress.title, fields: { ...this.progress } });
  }
  activity(message: string, done?: string, total?: string) {
    if (!this.progress) return;
    const activity = clean(message).replace(/[\r\n\t]/g, ' ');
    this.progress = { ...this.progress, activity, done: done === undefined ? undefined : Number(done), total: total === undefined ? undefined : Number(total), elapsedMs: Date.now() - this.started };
    this.log.emit({ level: 'debug', kind: 'progress', message: activity, fields: { ...this.progress } });
  }
  /** Take the live line down and say what's held back, before the result prints. */
  stopActivity() {
    this.progress = undefined;
    this.output?.sink.flush?.();
  }
  /** A fact worth a line in the log, once. */
  private notice(message: string) {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.log.info(message);
  }
  reading(path: string) { this.notice(`Checking ${here(path)}`); }
  found(path: string, discovery: string) {
    const at = here(path);
    this.notice(discovery === 'new' ? `Found a new package at ${at}` : discovery === 'additional-copy' ? `Found another copy at ${at}`
      : discovery === 'possible-move' ? `Found ${at}, and its main copy is missing` : `Found ${at}`);
  }
  phase(phase: Phase, op: Operation) {
    const zip = !!op.zipAdoption, inPlace = op.inPlace || op.destination === op.source;
    if (phase === 'planned') { const text = planned(op); if (text) this.notice(text); }
    else if (phase === 'building') this.activity(op.kind === 'pack' ? 'Packing and checking the replacement' : op.kind === 'unpack' ? 'Expanding and checking the replacement' : op.kind === 'import-zip' ? 'Reading the ZIP' : 'Building and checking the staged copy');
    else if (phase === 'verified') this.notice(zip ? 'ZIP entries checked and manifests written' : 'Staged copy verified');
    else if (phase === 'relocated') this.notice(zip ? 'Original ZIP moved into staging unchanged' : op.retainOriginal ? 'Original kept in a recovery folder' : 'Original set aside until the replacement is checked');
    else if (phase === 'published') this.notice(inPlace ? 'Replacement published' : 'Copy published');
    else if (phase === 'cleaning') this.activity('Removing the original');
  }
  /** Something that went wrong but didn't stop the command. */
  warn(message: string, next?: string) {
    this.log.emit({ level: 'warn', kind: 'notice', message: tildes(clean(message)), ...(next && { hint: { action: this.next(next) } }) });
  }

  help(usage: string, command?: string) {
    const t = this.t, width = Number.isFinite(this.width) ? this.width : 80;
    const usageOf = (c: string) => usage.split('\n').filter(l => l.startsWith(`  vestry ${c} `) || l === `  vestry ${c}`).map(l => l.trim());
    const section = (name: string, body: string[]) => body.length ? ['', heading(name, t, width), ...body] : [];
    const global = section('Global flags', definitions(flagTerms(GLOBAL_FLAGS, t), t, width));
    const help = command ? COMMANDS[command] : undefined;
    if (command && help) {
      this.print([
        ...paragraph(help.summary, t, width),
        ...section('Usage', usageOf(command).map(text => `  ${t.command(text)}`)),
        ...(help.details ?? []).flatMap(text => ['', ...paragraph(text, t, width, 2)]),
        ...section('Flags', definitions(flagTerms(help.flags ?? [], t), t, width)),
        ...global,
      ]);
      return;
    }
    const list = (commands: string[]) => definitions(commands.map(c => ({
      term: [[usageOf(c)[0].replace(/^vestry /, '').split(/ \[| --/)[0].replace('create DIR', 'create PATH'), t.command]] as Segment[],
      text: COMMANDS[c].summary,
    })), t, width);
    this.print([
      heading(`Vestry ${packageInfo.version}`, t, width),
      ...paragraph('Preserve files. Know where they live. Check them anytime.', t, width),
      ...section('Usage', [`  ${t.command('vestry <command> [flags]')}`]),
      ...section('Commands', list(EVERYDAY)),
      ...section('More commands', list(MORE)),
      ...global,
      '',
      ...paragraph('PACKAGE is a path, an alias, or a Content ID or the start of one. A package detects damage; a second copy recovers from it. To package a draft, run `vestry create DRAFT --from-draft --output DIR`. The older names `verify`, `inspect`, `locate`, and `move` still work.', t, width),
      '',
      ...paragraph('Add `--help` to any command to see its flags.', t, width),
    ]);
  }

  plan(result: Result) {
    const t = this.t;
    const entries = [
      ...result.reads.map((path: string) => ['Read', where(path)]),
      ...result.writes.map((path: string, i: number) => [i === result.writes.length - 1 ? 'Catalog' : 'Write', where(path)]),
      ['Staging', clean(result.staging)],
      ['Space', clean(result.scratch)],
      ...(result.moves ?? []).map((move: Result) => ['Move', `${where(move.from)} ${glyphs.arrow} ${where(move.to)}`]),
      ...(result.retains ? [['Keep', clean(result.retains)]] : []),
      ['Remove', result.deletes.length ? result.deletes.map(clean).join('\n') : 'nothing'],
      ...result.limitations.map((note: string) => ['Note', clean(note)]),
    ] as [string, string][];
    this.print([line([['Preview', t.strong], [`  vestry ${clean(result.command)}, nothing changed`, t.muted]], this.width), ...card(entries, t, this.width, 2)]);
  }

  /** Finder files set aside before packaging, so a package doesn't hold them. */
  private quarantine(reports: Result[], t: Tokens): string[] {
    return reports.flatMap(report => [
      line([[glyphs.warning, t.warning], [' '], [`${report.copyOnly ? 'Saved' : 'Moved'} ${count(report.files.length)} Finder ${plural('files', report.files.length)} aside`, t.strong]], this.width),
      ...card([['Folder', where(report.directory)], ...report.files.map((file: string) => ['File', where(file)] as [string, string])], t, this.width, 2),
    ]);
  }

  /**
   * Rows under muted headings and a rule, a word to a cell and paths last.
   * Nothing is cut, so grep and awk see every value; the terminal wraps a
   * row too long for it. The last column's rule stops at the terminal's edge.
   */
  private rows(headings: string[], cells: string[][], { numeric = [], muted = [], indent = 0 }: { numeric?: string[]; muted?: string[]; indent?: number } = {}): string[] {
    if (!cells.length) return [];
    const { lines } = table({ headings, cells, numeric: headings.map(h => numeric.includes(h)), muted: headings.map(h => muted.includes(h)) }, this.t, Number.POSITIVE_INFINITY);
    const widths = headings.map((heading, i) => Math.max(heading.length, ...cells.map(row => row[i].length)));
    const before = widths.slice(0, -1).reduce((sum, w) => sum + w + 2, indent);
    widths[widths.length - 1] = Math.max(headings.at(-1)!.length, Math.min(widths.at(-1)!, this.width - before));
    lines[1] = this.t.muted(widths.map(w => glyphs.rule.repeat(w)).join('  '));
    return lines.map(text => ' '.repeat(indent) + text);
  }

  /** A row per copy: what it is to the package, whether it's there, its form, and where. */
  private copies(locations: Result[], main: unknown, _t: Tokens, { checked = false } = {}): string[] {
    const copies = kept(locations), variants = new Set(copies.map(location => location.packageDigest)).size > 1;
    const headings = ['copy', 'state', 'format', ...(checked ? ['checked'] : []), ...(variants ? ['digest'] : []), 'path'];
    return this.rows(headings, copies.map(location => [role(location, main), state(location.availability), cell(location.representation),
      ...(checked ? [dayOf(location.lastVerifiedAt)] : []), ...(variants ? [shortId(location.packageDigest)] : []), where(location.path)]), { muted: ['checked'], indent: 2 });
  }

  /**
   * A row for each record type in the exports counted, one word to a cell so
   * grep and awk can read it, and a line for each export not counted.
   */
  private surveyTable(readers: Result[], t: Tokens, indent = 0): { lines: string[]; uncounted: string[] } {
    const counted = readers.filter(r => r.outcome === 'counted'), several = counted.length > 1;
    const cells = counted.flatMap(reader => Object.entries(reader.survey as Record<string, Result>).map(([kind, part]) => [
      clean(reader.source), ...(several ? [exportRoot(reader.root)] : []), clean(kind), String(part.count), dayOf(part.earliest), dayOf(part.latest),
      [...(part.asOf ? [`as-of=${dayOf(part.asOf)}`] : []), ...(part.measures ?? []).map(measure)].join(' '),
    ]));
    const measured = cells.some(row => row.at(-1));
    const headings = ['source', ...(several ? ['export'] : []), 'kind', 'count', 'first', 'last', ...(measured ? ['measures'] : [])];
    const { lines, hidden } = cells.length ? table({ headings, cells: measured ? cells : cells.map(row => row.slice(0, -1)), numeric: headings.map(h => h === 'count') }, t, this.width - indent) : { lines: [], hidden: [] };
    const dropped = hidden.length ? this.hint(`The ${hidden.join(' and ')} ${plural('columns', hidden.length)} didn't fit. Widen the terminal, or use \`--json\`.`) : [];
    return { lines: [...lines.map(text => ' '.repeat(indent) + text), ...dropped], uncounted: readers.filter(r => r.outcome !== 'counted').map(r => `${clean(r.source)} in ${exportRoot(r.root)}: ${clean(r.reason)}`) };
  }

  result(command: string, result: Result, subcommand?: string) {
    if (command === 'survey') {
      const { lines, uncounted } = this.surveyTable(result.readers, this.t);
      this.print(lines);
      for (const note of uncounted) this.warn(note);
      if (!result.readers.length) this.warn('Chronicle didn\'t recognize an export in this package', 'Run `chronicle sources --all` to see what it reads.');
      return;
    }
    const lines = command === 'scan' ? this.scan(result)
      : Array.isArray(result.packages) ? this.packages(result.packages)
      : Array.isArray(result.operations) ? this.operations(command, result.operations)
      : Array.isArray(result.copies) ? this.cached(result.copies)
      : this.details(command, result, subcommand);
    if (result.quarantined?.length) lines.push('', ...this.quarantine(result.quarantined, this.t));
    this.print(lines);
  }

  /** A blank line, a title, and the lines under it; nothing when there are none. */
  private section(name: string, body: string[], after: Segment[] = []): string[] {
    return body.length ? ['', line([[name, this.t.strong], ...after], this.width), ...body] : [];
  }

  private scan(result: Result): string[] {
    const t = this.t, s = result.summary, issues = result.issues as Result[];
    // Never cut: the folder is the point of the line.
    const out = [summary({ status: issues.length ? 'warning' : 'success', title: `Scanned ${where(result.root)}`, durationMs: Date.now() - this.started }, t, Number.POSITIVE_INFINITY)];
    // The counts as a column, the way Chronicle sums up a run.
    const rows: [number, string, Style?][] = [
      [s.verified, `${plural('copies', s.verified)} checked`],
      [s.packages, `${plural('packages', s.packages)}, ${count(s.newPackages)} new`],
      ...(s.mainLocationsSet ? [[s.mainLocationsSet, `main ${plural('copies', s.mainLocationsSet)} set`]] as [number, string][] : []),
      ...(s.possibleMoves ? [[s.possibleMoves, `possible ${plural('moves', s.possibleMoves)}`, t.warning]] as [number, string, Style][] : []),
      ...(issues.length ? [[issues.length, plural('problems', issues.length), t.danger]] as [number, string, Style][] : []),
    ];
    const digits = Math.max(...rows.map(([n]) => count(n).length));
    out.push(...rows.map(([n, label, style]) => line([['  '], [count(n).padStart(digits), style ?? t.strong], [' '], [label, style]], this.width)));
    if (!s.candidates) out.push(...this.hint('No packages found. Run `vestry create PATH` to make one from a folder or ZIP.'));
    const findings = result.findings as Result[];
    out.push(...this.section('Copies', this.rows(['package', 'found', 'copy', 'path'], findings.map(finding => [shortId(finding.contentId ?? finding.packageDigest), cell(finding.discovery),
      finding.mainAction === 'set' ? 'made-main' : finding.mainLocation === finding.path ? 'main' : 'copy', where(finding.path)]), { indent: 2 })));
    for (const finding of findings.filter(f => f.discovery === 'possible-move')) {
      out.push(...this.hint(`The main copy at ${where(finding.previousMainLocation)} is missing. It may be on a drive that isn't connected. To make ${where(finding.path)} the main copy: \`vestry register ${pathArg(finding.path)} --main\``));
    }
    if (result.exports?.length) {
      const exports = result.exports as Result[];
      out.push(...this.section('Not in a package', this.rows(['source', 'status', 'path'], exports.map(e => [cell(e.source), cell(e.status), where(e.path)]), { indent: 2 }),
        [['  exports Chronicle recognizes', t.muted]]));
      out.push(...this.hint(`To package one: \`vestry create ${pathArg(exports[0].path)}\``));
    }
    out.push(...this.section('Problems', issues.flatMap(issue => issue.code === 'AMBIGUOUS_MAIN_LOCATION'
      ? [line([['  '], [glyphs.failure, t.danger], [' '], [clean(issue.message)]], Number.POSITIVE_INFINITY), ...this.hint(['Pick the main copy:', ...(issue.candidates as string[]).map(path => `\`vestry register ${pathArg(path)} --main\``)].join('\n'))]
      : [line([['  '], [glyphs.failure, t.danger], [' '], [where(issue.path)], [`  ${clean(issue.message)}`, t.muted]], Number.POSITIVE_INFINITY)])));
    out.push(...this.section('Skipped', this.rows(['reason', 'path'], (result.skipped as Result[]).map(skip => [cell(skip.reason), where(skip.path)]), { indent: 2 })));
    return out;
  }

  /** Each package on a line, its name and size, with a line under it for each copy. */
  private packages(packages: Result[]): string[] {
    const t = this.t;
    if (!packages.length) return ['No packages yet', ...this.hint('Run `vestry create PATH` to make one from a folder or ZIP.')];
    return packages.flatMap((pkg, i) => {
      const first = (pkg.locations as Result[] ?? []).find(l => l.availability === 'available' && l.storage === 'external');
      return [
        ...(i ? [''] : []),
        line([[named(pkg), t.strong], [pkg.aliases?.length ? `  ${shortId(pkg.contentId ?? pkg.packageDigest)}` : ''], [contents(pkg) ? `  ${contents(pkg)}` : '', t.muted]], Number.POSITIVE_INFINITY),
        ...this.copyLines(pkg.locations ?? [], pkg.mainLocation, t),
        ...(pkg.mainLocation ? [] : this.hint(first ? `No main copy. Run \`vestry register ${pathArg(first.path)} --main\` to make this one the main copy.` : 'No main copy. Run `vestry register PATH --main` to pick one.')),
      ];
    });
  }

  /** A copy per line, as list shows them under their package: whether it's there, where, and what kind. */
  private copyLines(locations: Result[], main: unknown, t: Tokens): string[] {
    const copies = kept(locations), paths = column(copies.map(location => where(location.path)));
    const variants = new Set(copies.map(location => location.packageDigest)).size > 1;
    return copies.map((location, i) => {
      const [glyph, ...state] = availability(location.availability, t);
      const labels = [location.path === main ? 'main' : '', clean(location.representation), location.storage && location.storage !== 'external' ? clean(location.storage) : '',
        variants ? shortId(location.packageDigest) : ''].filter(Boolean);
      return line([['  '], glyph, [' '], [paths[i]], [labels.length ? `  ${labels.join('  ')}` : '', t.muted], ...state], Number.POSITIVE_INFINITY);
    });
  }

  private operations(command: string, operations: Result[]): string[] {
    const t = this.t;
    if (!operations.length) return [command === 'recover' ? 'Nothing to recover' : 'No operations recorded'];
    const unfinished = (op: Result) => !['succeeded', 'discarded'].includes(op.status), staged = operations.some(unfinished);
    const out = this.rows(['date', 'time', 'kind', 'status', ...(staged ? ['stage'] : []), 'operation', 'path'], operations.map(op => [
      ...stamp(op.startedAt), cell(op.kind), cell(op.status), ...(staged ? [unfinished(op) ? cell(op.phase) : '-'] : []), cell(op.id),
      `${where(op.source)}${op.destination && op.source !== op.destination ? ` ${glyphs.arrow} ${where(op.destination)}` : ''}`,
    ]), { muted: ['date', 'time'] });
    // What went wrong, then the originals still kept, each under the table.
    for (const op of operations.filter(op => op.error)) out.push(line([[glyphs.failure, t.danger], [' '], [`${clean(op.kind)} ${clean(op.id)}`, t.strong], [`  ${clean(op.error.message)}`]], Number.POSITIVE_INFINITY));
    for (const op of operations.filter(op => op.retainOriginal && !op.sourceRetired && op.result?.cleanupRequired)) {
      out.push(...this.hint(`The original from ${clean(op.kind)} ${clean(op.id)} is kept at ${where(op.backup)}. To remove it: \`vestry cleanup ${clean(op.id)}\``));
    }
    if (command === 'recover') {
      out.push('', ...this.hint(operations.length === 1 ? `Run \`vestry recover ${clean(operations[0].id)}\` to finish it, or add \`--discard\` to throw its work away.`
        : 'Run `vestry recover OPERATION-ID` to finish one, or add `--discard` to throw its work away.'));
    }
    return out;
  }

  private cached(copies: Result[]): string[] {
    if (!copies.length) return ['No local copies', ...this.hint('Run `vestry cache add PACKAGE --pin` to keep one for when your archive is offline.')];
    return this.rows(['package', 'storage', 'state', 'format', 'path'], copies.map(copy => [shortId(copy.contentId), copy.pinned ? 'pinned' : 'disposable', state(copy.availability), cell(copy.representation), where(copy.path)]));
  }

  /** A package or an operation on one: what happened, then its details. */
  private details(command: string, result: Result, subcommand?: string): string[] {
    const t = this.t, width = this.width;
    const lookup = ['show', 'locate'].includes(command), described = ['show', 'locate', 'inspect'].includes(command);
    const out = [lookup
      ? line([[named(result), t.strong], [result.aliases?.length ? `  ${shortId(result.contentId)}` : '', t.muted]], width)
      : summary({ status: result.status === 'interrupted' ? 'warning' : 'success', title: title(command, result, subcommand), durationMs: Date.now() - this.started }, t, width)];
    const entries: [string, string | undefined][] = [
      ['Location', result.path && where(result.path)],
      ['Main', !lookup && result.mainLocation && result.mainLocation !== result.path ? where(result.mainLocation) : undefined],
      ['Format', lookup ? undefined : format(result.representation)],
      ['Contents', contents(result) ?? (described ? 'not recorded yet' : undefined)],
      ['Aliases', !lookup && result.aliases?.length ? clean(result.aliases.join(', ')) : undefined],
      ['Content ID', clean(result.contentId ?? result.payloadDigest) || undefined],
      ['Package digest', ['show', 'inspect', 'check', 'verify'].includes(command) && result.packageDigest ? clean(result.packageDigest) : undefined],
      ['Identity', result.identityConfidence === 'expected' ? 'expected from the catalog, not rechecked' : ['pack', 'unpack'].includes(command) ? 'unchanged, with its catalog details' : undefined],
      ['Storage', result.storage === 'pinned' ? 'pinned, kept until you unpin it' : result.storage === 'cache' ? 'disposable cache' : result.storage && clean(result.storage)],
      ['Original', result.sourceMoved ? 'moved in unchanged, as data.zip' : result.sourceRetained ? 'kept, unchanged' : undefined],
      ['Recovery copy', result.cleanupRequired ? where(result.recoveryCopy) : undefined],
      ['Operation', clean(result.operationId) || undefined],
    ];
    out.push(...card(entries.filter((entry): entry is [string, string] => !!entry[1]), t, width, 2));
    if (result.message) out.push(...paragraph(this.next(clean(result.message)), t, width, 2));
    if (result.cleanupRequired) out.push(...this.hint(`The original still takes up space. Once you've checked ${command === 'eject' ? 'the restored files' : 'the new copy'}, run \`vestry cleanup ${clean(result.operationId)}\` to remove it.`));
    if (described && contents(result) === undefined) out.push(...this.hint(`Run \`vestry check ${shortId(result.contentId)}\` to record its contents.`));
    if (result.locations?.length) out.push(...this.section('Copies', this.copies(result.locations, result.mainLocation, t, { checked: true })));
    if (result.metadata) {
      out.push(...this.section('Catalog', card((['title', 'description', 'notes'] as const).filter(key => result.metadata[key])
        .map(key => [key[0].toUpperCase() + key.slice(1), clean(String(result.metadata[key]).trimEnd())] as [string, string]), t, width, 2)));
    }
    if (new Set((result.metadataVariants ?? []).map((v: Result) => JSON.stringify([v.metadata?.title, v.metadata?.description, v.metadata?.notes]))).size > 1) {
      out.push(...this.hint(`Copies have different catalog details. Run \`vestry inspect ${shortId(result.contentId)} --json\` to see them all.`));
    }
    if (result.readers?.length) {
      out.push(...this.section('Readers', this.rows(['source', 'strategy', 'status', 'export'], (result.readers as Result[]).map(r => [cell(r.source), cell(r.strategy), cell(r.status), exportRoot(r.root)]), { indent: 2 })));
    }
    if (result.lastSurvey) {
      const { lines, uncounted } = this.surveyTable(result.lastSurvey.readers, t, 2);
      out.push(...this.section('Last survey', [...lines, ...uncounted.map(note => line([['  '], [glyphs.warning, t.warning], [' '], [note]], Number.POSITIVE_INFINITY))], [[`  ${when(result.lastSurvey.endedAt)}`, t.muted]]));
    }
    const prose = (text: unknown) => String(text).trimEnd().split('\n').flatMap(part => part ? paragraph(clean(part), t, width, 2, { cut: false }) : ['']);
    if (result.sealedReadme) out.push(...this.section('README.txt', prose(result.sealedReadme), [['  in the package', t.muted]]));
    if (result.readme) out.push(...this.section('Description', prose(result.readme)));
    if (result.timings?.length) out.push(...this.section('Timings', card((result.timings as Result[]).map(timing => [`${Number(timing.seconds).toFixed(1)}s`, clean(timing.stage)]), t, width, 2)));
    return out;
  }

  /**
   * What stopped the command, and what to do about it: the error's hint, a
   * command to run for each candidate it names, or the command's help.
   */
  error(command: string, failure: Failure, reports: Result[] = [], retry?: (candidate: string) => string | undefined) {
    // Cancelling is a choice, not a failure: said plainly.
    if (failure.details.cancelled) return this.log.info(clean(failure.message));
    const steps: string[] = [];
    if (failure.hint) steps.push(failure.hint);
    if (failure.details.operationId && !failure.hint?.includes('vestry recover')) steps.push(`Its operation is ${failure.details.operationId}. Run \`vestry recover\` to see what's unfinished.`);
    else if (!failure.hint && failure.exitCode === 2) steps.push(COMMANDS[command] ? `Run \`vestry ${command} --help\` for help.` : 'Run `vestry --help` to see the commands.');
    const candidates = (failure.details.candidates ?? []) as string[];
    if (candidates.length) {
      const commands = candidates.map(candidate => retry?.(candidate));
      steps.push(commands.every(Boolean) ? ['Pick one:', ...commands.map(text => `\`${text}\``)].join('\n')
        : ['Pass one of these:', ...candidates.map(candidate => `\`${pathArg(clean(candidate))}\``)].join('\n'));
    }
    this.stopActivity();
    this.log.emit({ level: 'error', kind: 'error', message: tildes(clean(failure.message)), error: { code: failure.code, exitCode: failure.exitCode },
      ...(steps.length && { hint: { action: this.next(steps.join('\n')) } }) });
    this.log.flush();
    if (reports.length) process.stderr.write(`${this.quarantine(reports, tokens(colorEnabled(this.mode, !!process.stderr.isTTY))).join('\n')}\n`);
  }
}
