import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonical, exists, within } from './fs-util.js';
import { diagnostic, usage } from './errors.js';
import { homePath, listOperations, retireAbandoned, type Context } from './operations.js';
import { cacheRoot } from './cache.js';
import { adoptMain } from './locations.js';
import { readRegistry, rememberVerified, withReference } from './registry.js';
import { verifyRecorded } from './workflow.js';
import type { Verification } from './package.js';

interface Finding {
  path: string; contentId: string; packageDigest: string; representation: string;
  discovery: 'new' | 'known' | 'additional-copy' | 'possible-move';
  previousMainLocation: string | null; mainLocation?: string | null;
  mainAction?: 'set' | 'unchanged' | 'ambiguous'; operationId: string;
}
interface Issue { path: string; code: string; message: string; exitCode: number; operationId?: unknown; candidates?: string[] }

export async function scanDirectory(input: string, context: Context & { makeMain?: boolean; offline?: boolean; onFound?: (finding: Finding) => void } = {}): Promise<Record<string, unknown>> {
  if (!(await lstat(resolve(input))).isDirectory()) throw usage('scan requires a regular directory; symlink roots are not followed.');
  const root = await canonical(input);
  for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
    if (await exists(join(parent, 'bagit.txt')) || await exists(join(parent, '.vestry-draft.json'))) throw usage('Scan a package root or its containing directory, not a package payload or draft.');
  }
  const excluded = await Promise.all([homePath(context.home), cacheRoot(context)].map(path => canonical(path)));
  const before = await readRegistry(context);
  for (const op of await listOperations(context)) if ([op.source, op.destination].some(p => p && within(p, root))) await retireAbandoned(op.id, context);
  const pending = (await listOperations(context)).filter(op => !['succeeded', 'discarded'].includes(op.status) && (op.inPlace || ['create', 'move', 'copy', 'eject', 'cache-copy', 'import-zip', 'gather'].includes(op.kind)));
  const findings: Finding[] = [], issues: Issue[] = [], skipped: { path: string; reason: string }[] = [];
  let directories = 0, candidates = 0;
  function issue(path: string, error: unknown) {
    context.signal?.throwIfAborted();
    const failure = diagnostic(error);
    issues.push({ path, code: failure.code, message: failure.message, exitCode: failure.exitCode, operationId: failure.details.operationId });
  }
  const stack = [root];
  while (stack.length) {
    context.signal?.throwIfAborted();
    const path = stack.pop()!;
    try {
      if (excluded.some(exclude => within(path, exclude))) { skipped.push({ path, reason: 'Vestry workspace or managed cache' }); continue; }
      // Recheck after discovery: do not follow a directory replaced by a symlink.
      if (!(await lstat(path)).isDirectory() || await canonical(path) !== path) { skipped.push({ path, reason: 'Not a regular directory or path redirected' }); continue; }
      const entries = await readdir(path, { withFileTypes: true }); directories++;
      if (entries.some(entry => entry.name === '.vestry-draft.json')) { skipped.push({ path, reason: 'Editable draft' }); continue; }
      if (pending.some(op => [op.source, op.destination, op.staging, op.backup].some(p => p && within(path, p)))) { skipped.push({ path, reason: 'Unfinished operation; recover it before scanning' }); continue; }
      if (entries.some(entry => entry.name === 'bagit.txt')) {
        candidates++;
        // A candidate is a boundary even when validation fails. Never reinterpret
        // its preserved payload as independent packages.
        try {
          const result = await withReference(path, context, async selected => {
            const verified = await verifyRecorded(path, { ...context, expected: selected.expected, register: false });
            await rememberVerified(path, verified as unknown as Verification, context, { deferMain: true });
            return verified;
          });
          const id = result.packageDigest as string, prior = Object.values(before.packages).find(r => r.payloadDigest === result.payloadDigest && r.mainLocation) ?? Object.values(before.packages).find(r => r.payloadDigest === result.payloadDigest);
          let discovery: Finding['discovery'] = !prior ? 'new' : Object.values(before.packages).some(r => r.payloadDigest === result.payloadDigest && r.locations.some(l => l.path === path && l.state !== 'evicted')) ? 'known' : 'additional-copy';
          if (prior?.mainLocation && prior.mainLocation !== path && !context.offline) {
            try { if (!await exists(prior.mainLocation)) discovery = 'possible-move'; }
            catch (error) { issue(prior.mainLocation, error); }
          }
          const finding: Finding = { path, contentId: result.payloadDigest as string, packageDigest: id, representation: result.representation as string, discovery,
            previousMainLocation: prior?.mainLocation ?? null, operationId: result.operationId as string };
          findings.push(finding); context.onFound?.(finding);
        } catch (error) { issue(path, error); }
        continue;
      }
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) skipped.push({ path: child, reason: 'Symlink not followed' });
        else if (entry.isDirectory()) {
          if (/^\.vestry-[0-9a-f-]{36}\.(tmp|original)$/.test(entry.name)) skipped.push({ path: child, reason: 'Vestry staging or original backup' });
          else stack.push(child);
        }
      }
    } catch (error) { issue(path, error); }
  }

  const groups = new Map<string, Finding[]>();
  for (const finding of findings) groups.set(finding.contentId, [...(groups.get(finding.contentId) ?? []), finding]);
  for (const [id, copies] of groups) {
    context.signal?.throwIfAborted();
    const records = Object.values((await readRegistry(context)).packages).filter(r => r.payloadDigest === id);
    const record = records.find(r => r.mainLocation) ?? records[0];
    if (copies.length > 1 && (context.makeMain || !record?.mainLocation)) {
      for (const copy of copies) copy.mainAction = 'ambiguous';
      issues.push({ path: root, code: 'AMBIGUOUS_MAIN_LOCATION', exitCode: 5,
        message: `Multiple copies of ${id} were found. Choose one with vestry register PATH --main.`, candidates: copies.map(copy => copy.path) });
    } else if (copies.length === 1 && (context.makeMain || !record?.mainLocation)) {
      const copy = copies[0];
      try {
        // Discovery can take time. Reverify the chosen copy under a fresh reader
        // lease before making it authoritative, and serialize the main change.
        await withReference(copy.path, context, async selected => {
          await verifyRecorded(copy.path, { ...context, expected: copy.packageDigest, register: false });
          await adoptMain(copy.path, copy.packageDigest, selected.lease, context, !context.makeMain);
        });
        copy.mainAction = record?.mainLocation === copy.path ? 'unchanged' : 'set';
      } catch (error) { issue(copy.path, error); }
    }
    const main = Object.values((await readRegistry(context)).packages).find(r => r.payloadDigest === id && r.mainLocation)?.mainLocation ?? null;
    for (const copy of copies) { copy.mainLocation = main; copy.mainAction ??= 'unchanged'; }
  }
  return { status: issues.length ? 'complete-with-issues' : 'complete', root, findings, issues, skipped,
    summary: { directories, candidates, verified: findings.length, packages: groups.size,
      newPackages: [...groups.keys()].filter(id => !Object.values(before.packages).some(r => r.payloadDigest === id)).length,
      possibleMoves: findings.filter(f => f.discovery === 'possible-move').length,
      mainLocationsSet: findings.filter(f => f.mainAction === 'set').length, issues: issues.length, skipped: skipped.length },
    exitCode: issues.length ? 1 : 0 };
}
