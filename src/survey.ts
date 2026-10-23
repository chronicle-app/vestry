import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { cacheRoot } from './cache.js';
import { chronicleVersion, scanExports, surveyExport, type KindSurvey } from './chronicle.js';
import { conflict, diagnostic, integrity, usage } from './errors.js';
import { atomicJson, within } from './fs-util.js';
import { parseManifest, utf8 } from './inventory.js';
import { homePath, workspace, type Context } from './operations.js';
import { readRegistry, withReference } from './registry.js';
import { verifyRecorded } from './workflow.js';

/**
 * A Chronicle source that reads an export inside a package. Readers are kept
 * by Content ID, so one found in any copy serves every copy and form.
 */
export interface Reader {
  source: string; strategy: string; plugin: string; status: string;
  /** Where the export starts under data/, with `/`; empty for the whole payload. */
  root: string;
  /** The run's options besides its input, as Chronicle's scan bound them. */
  options: Record<string, unknown>;
  files?: string[]; layout?: string; pluginVersion?: string;
  foundAt: string; chronicle: string;
}
export interface ReaderSurvey {
  source: string; strategy: string; root: string; pluginVersion?: string;
  outcome: 'counted' | 'no-answer' | 'failed' | 'skipped'; reason?: string;
  survey?: Record<string, KindSurvey>;
}
export interface SurveyRecord {
  schemaVersion: 1; id: string; contentId: string; packageDigest: string;
  path: string; representation: 'expanded' | 'packed';
  identityConfidence: 'expected' | 'verified'; lastVerifiedAt?: string;
  startedAt: string; endedAt: string; chronicle: string; readers: ReaderSurvey[];
}

const recordName = (contentId: string) => `${contentId.replaceAll(':', '-')}.json`;
const payload = (path: string, representation: 'expanded' | 'packed') => join(path, representation === 'packed' ? 'data.zip' : 'data');
const below = (path: string, rest: string) => join(path, ...rest.split('/').filter(Boolean));

/** Copy one payload file out of a packed copy's data.zip. */
async function copyOut(path: string, member: string, destination: string, signal?: AbortSignal): Promise<void> {
  const zip = await yauzl.openPromise(join(path, 'data.zip'), { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true });
  try {
    for await (const entry of zip.eachEntry()) {
      if (utf8.decode(entry.fileNameRaw) !== member) continue;
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(destination, { flags: 'wx' }), { signal });
      return;
    }
    throw integrity(`data.zip does not hold ${member}.`);
  } finally { zip.close(); }
}

/**
 * Where Chronicle reads an export in this copy: a folder, data.zip, or a
 * folder through it. Chronicle can't look into a ZIP inside data.zip, so in a
 * packed copy each payload ZIP it needs is copied out to Vestry's cache for
 * the survey, and removed after.
 */
function exportInputs(path: string, representation: 'expanded' | 'packed', context: Context) {
  const scratch = join(cacheRoot(context), 'scratch', randomUUID()), copied = new Map<string, string>();
  let zips: Promise<string[]> | undefined;
  const files = {
    /** The payload ZIPs Chronicle can't reach in this copy, by path under data/. */
    zips: () => representation === 'expanded' ? Promise.resolve([]) : zips ??= readFile(join(path, 'manifest-sha256.txt'), 'utf8').then(text => [...parseManifest(text).keys()].filter(p => /\.zip$/i.test(p)).map(p => p.slice('data/'.length))),
    async copy(member: string): Promise<string> {
      if (!copied.has(member)) {
        const file = join(scratch, String(copied.size), basename(member));
        context.onActivity?.(`Copying ${member} out of data.zip for Chronicle…`);
        await copyOut(path, member, file, context.signal); copied.set(member, file);
      }
      return copied.get(member)!;
    },
    async discard(member: string) { await rm(dirname(copied.get(member)!), { recursive: true, force: true }); copied.delete(member); },
    async input(root: string): Promise<string> {
      const member = (await files.zips()).find(m => root === m || root.startsWith(`${m}/`));
      return member ? below(await files.copy(member), root.slice(member.length)) : below(payload(path, representation), root);
    },
    close: () => rm(scratch, { recursive: true, force: true }),
  };
  return files;
}

async function readReaders(home: string, contentId: string): Promise<Reader[] | undefined> {
  try { return (JSON.parse(await readFile(join(home, 'readers', recordName(contentId)), 'utf8')) as { readers: Reader[] }).readers; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
async function readSurveys(home: string, contentId: string): Promise<SurveyRecord[]> {
  let names: string[];
  try { names = await readdir(join(home, 'surveys')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(home, 'surveys', name), 'utf8')) as SurveyRecord));
  return records.filter(record => record.contentId === contentId).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

/**
 * Each export Chronicle finds in this copy's payload, and in each payload ZIP
 * it can't reach through data.zip, as a reader. A root outside what was
 * scanned is dropped: Chronicle looks above a folder that holds no export,
 * for the export that folder is in.
 */
async function findReaders(path: string, representation: 'expanded' | 'packed', files: ReturnType<typeof exportInputs>, chronicle: string, signal?: AbortSignal): Promise<Reader[]> {
  const foundAt = new Date().toISOString(), readers: Reader[] = [];
  const scan = async (target: string, prefix: string) => {
    for (const row of await scanExports(target, signal)) {
      if (!row.root || !within(row.root, target)) continue;
      const { input: _input, ...options } = row.config;
      readers.push({ source: row.source, strategy: row.strategy, plugin: row.plugin, status: row.status, root: [prefix, relative(target, row.root).split(sep).join('/')].filter(Boolean).join('/'), options,
        ...(row.evidence?.files && { files: row.evidence.files }), ...(row.layout && { layout: row.layout }), ...(row.pluginVersion && { pluginVersion: row.pluginVersion }), foundAt, chronicle });
    }
  };
  await scan(payload(path, representation), '');
  for (const member of await files.zips()) {
    const before = readers.length;
    await scan(await files.copy(member), member);
    if (readers.length === before) await files.discard(member);
  }
  return readers;
}

/**
 * Count what each export in a package holds, with Chronicle, reading the
 * selected copy in place. Readers are found on the first survey, or again
 * with `find`. Each survey is kept as a dated record; package bytes never change.
 */
export async function surveyPackage(ref: string, context: Context & { offline?: boolean; location?: string; check?: boolean; find?: boolean } = {}): Promise<Record<string, unknown>> {
  return withReference(ref, context, async resolved => {
    const registered = (state: Awaited<ReturnType<typeof readRegistry>>) => Object.values(state.packages).find(p => p.locations.some(l => l.path === resolved.path && l.state !== 'evicted'));
    const known = registered(await readRegistry(context));
    if (!known) throw usage('Register this package with scan before surveying it.');
    if (!context.check && known.locations.find(l => l.path === resolved.path)!.state === 'changed') throw conflict('This copy changed since it was last checked. Run vestry check on it first.');
    const startedAt = new Date().toISOString(), chronicle = await chronicleVersion(context.signal);
    if (context.check) await verifyRecorded(resolved.path, { ...context, expected: resolved.expected });
    const record = registered(await readRegistry(context))!, location = record.locations.find(l => l.path === resolved.path)!;
    const home = await workspace(context, [resolved.path]), contentId = record.payloadDigest;
    const files = exportInputs(resolved.path, location.representation, context);
    try {
      let readers = context.find ? undefined : await readReaders(home, contentId);
      const found = !readers;
      if (!readers) {
        context.onActivity?.('Finding exports with Chronicle…');
        readers = await findReaders(resolved.path, location.representation, files, chronicle, context.signal);
        // Finding none is not kept: another copy, or a newer Chronicle, may find some.
        if (readers.length) {
          await mkdir(join(home, 'readers'), { recursive: true });
          await atomicJson(join(home, 'readers', recordName(contentId)), { schemaVersion: 1, contentId, readers });
        }
      }
      const results: ReaderSurvey[] = [];
      for (const reader of readers) {
        const base = { source: reader.source, strategy: reader.strategy, root: reader.root };
        if (reader.status !== 'ready') {
          results.push({ ...base, outcome: 'skipped', reason: reader.status === 'unsupported' ? 'Chronicle recognizes this export but cannot read it yet.' : `Chronicle reports it as ${reader.status}.` });
          continue;
        }
        context.onActivity?.(`Counting ${reader.source}…`);
        try {
          const row = await surveyExport(reader.source, reader.strategy, await files.input(reader.root), reader.options, context.signal);
          results.push({ ...base, ...(row.pluginVersion && { pluginVersion: row.pluginVersion }), ...(row.survey ? { outcome: 'counted', survey: row.survey } : { outcome: row.error ? 'failed' : 'no-answer', reason: row.error ?? 'Chronicle cannot say how much it holds.' }) });
        } catch (error) {
          const failure = diagnostic(context.signal?.aborted ? context.signal.reason : error);
          if (failure.code !== 'CHRONICLE_FAILED') throw failure;
          results.push({ ...base, outcome: 'failed', reason: failure.message });
        }
      }
      const survey: SurveyRecord = { schemaVersion: 1, id: randomUUID(), contentId, packageDigest: record.packageDigest, path: resolved.path, representation: location.representation,
        identityConfidence: context.check ? 'verified' : 'expected', lastVerifiedAt: location.lastVerifiedAt, startedAt, endedAt: new Date().toISOString(), chronicle, readers: results };
      await mkdir(join(home, 'surveys'), { recursive: true });
      await atomicJson(join(home, 'surveys', `${survey.id}.json`), survey);
      const { schemaVersion: _version, id, ...rest } = survey;
      return { surveyId: id, ...rest, foundReaders: found, exitCode: results.some(r => r.outcome === 'failed') ? 1 : 0 };
    } finally { await files.close(); }
  });
}

/** A package's readers and its latest survey, for show. */
export async function surveyed(contentId: string, context: Context = {}): Promise<{ readers?: Reader[]; lastSurvey?: SurveyRecord }> {
  const home = homePath(context.home);
  return { readers: await readReaders(home, contentId), lastSurvey: (await readSurveys(home, contentId)).at(-1) };
}
