import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { chronicleVersion, scanExports, surveyExport, type KindSurvey } from './chronicle.js';
import { conflict, diagnostic, usage } from './errors.js';
import { atomicJson, within } from './fs-util.js';
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
/** The path a run reads an export from in this copy: a folder, the payload ZIP, or a folder through it. */
const exportPath = (path: string, representation: 'expanded' | 'packed', root: string) => join(payload(path, representation), ...root.split('/').filter(Boolean));

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
 * Each export Chronicle finds in this copy's payload, as a reader. A root
 * outside the payload is dropped: Chronicle looks above a folder that holds
 * no export, for the export that folder is in.
 */
async function findReaders(path: string, representation: 'expanded' | 'packed', chronicle: string, signal?: AbortSignal): Promise<Reader[]> {
  const base = payload(path, representation), foundAt = new Date().toISOString();
  return (await scanExports(base, signal)).flatMap(row => {
    if (!row.root || !within(row.root, base)) return [];
    const { input: _input, ...options } = row.config;
    return [{ source: row.source, strategy: row.strategy, plugin: row.plugin, status: row.status, root: relative(base, row.root).split(sep).join('/'), options,
      ...(row.evidence?.files && { files: row.evidence.files }), ...(row.layout && { layout: row.layout }), ...(row.pluginVersion && { pluginVersion: row.pluginVersion }), foundAt, chronicle }];
  });
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
    let readers = context.find ? undefined : await readReaders(home, contentId);
    const found = !readers;
    if (!readers) {
      context.onActivity?.('Finding exports with Chronicle…');
      readers = await findReaders(resolved.path, location.representation, chronicle, context.signal);
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
        const row = await surveyExport(reader.source, reader.strategy, exportPath(resolved.path, location.representation, reader.root), reader.options, context.signal);
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
  });
}

/** A package's readers and its latest survey, for show. */
export async function surveyed(contentId: string, context: Context = {}): Promise<{ readers?: Reader[]; lastSurvey?: SurveyRecord }> {
  const home = homePath(context.home);
  return { readers: await readReaders(home, contentId), lastSurvey: (await readSurveys(home, contentId)).at(-1) };
}
