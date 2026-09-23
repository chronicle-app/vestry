import { join, resolve } from 'node:path';
import { buildBag, buildConversion, requirePackageDirectory, verify } from './package.js';
import { readDraft, checkDraft } from './draft.js';
import { VestryError, conflict, diagnostic, integrity, usage } from './errors.js';
import { markChanged, rememberVerified } from './registry.js';
import { fail, newOperation, save, transaction, workspace, type Checked, type Context, type Operation } from './operations.js';
import { quarantineFinderFiles } from './quarantine.js';

export async function checkPackage(path: string): Promise<Checked> {
  const result = await verify(path); return { identity: result.packageDigest, result: { ...result } };
}
export const checkOutput = (path: string, kind: Operation['kind']) => kind === 'gather' ? checkDraft(path) : kind === 'eject' ? import('./eject.js').then(m => m.checkEjected(path)) : checkPackage(path);

export async function sealDraft(source: string, destination: string, options: Context & { packed?: boolean; catalogOnly?: boolean } = {}): Promise<Record<string, unknown>> {
  source = resolve(source);
  const before = await readDraft(source);
  if (options.catalogOnly) options = { ...options, catalogMetadata: { description: before.metadata.description, notes: before.readme } };
  if (!options.catalogOnly && !before.readme.trim()) throw usage('Draft README is empty. Run vestry describe DRAFT --edit or --description TEXT first.');
  return transaction('seal', source, destination, async stage => {
    await buildBag(join(source, 'data'), stage, options.catalogOnly ? undefined : before.readme, options.catalogOnly ? undefined : before.metadata.description, options.packed, options.signal, options.onActivity);
    const after = await readDraft(source);
    if (before.readme !== after.readme || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) throw conflict('Draft description changed during sealing.');
  }, checkPackage, options);
}

export async function convertPackage(source: string, destination: string, target: 'packed' | 'expanded', options: Context & { compress?: boolean; zip64?: boolean } = {}): Promise<Record<string, unknown>> {
  options.onRead?.(source);
  const quarantined = await quarantineFinderFiles(source, options);
  const before = await verify(source);
  if (options.expected && before.packageDigest !== options.expected) {
    await markChanged(source, options, before.packageDigest);
    throw new VestryError('LOCATION_CHANGED', 'Selected path contains a different package revision.', 5, { expected: options.expected, actual: before.packageDigest });
  }
  if (before.representation === target) throw conflict(`Package is already ${target}; no conversion needed.`);
  const result = await transaction(target === 'packed' ? 'pack' : 'unpack', source, destination,
    async stage => {
      const current = await verify(source);
      if (current.packageDigest !== before.packageDigest) throw integrity('Source changed before conversion; original retained.');
      await buildConversion(source, stage, before, options);
    }, async stage => {
      const checked = await checkPackage(stage);
      if (checked.identity !== before.packageDigest) throw integrity('Conversion changed package identity.');
      return checked;
    }, options);
  return { ...result, ...(quarantined ? { quarantined: [quarantined] } : {}) };
}

export async function verifyRecorded(source: string, context: Context & { register?: boolean } = {}): Promise<Record<string, unknown>> {
  source = resolve(source);
  try { await requirePackageDirectory(source, context.expected); }
  catch (error) {
    if (context.register !== false && diagnostic(error).exitCode === 3) await markChanged(source, context).catch(() => undefined);
    throw error;
  }
  const home = await workspace(context, [source]);
  const op = await newOperation(home, 'verify', source);
  try {
    if (context.expected) { op.expected = context.expected; await save(home, op); }
    context.onRead?.(source);
    const quarantined = await quarantineFinderFiles(source, context);
    context.signal?.throwIfAborted();
    const result = await verify(source); context.signal?.throwIfAborted();
    if (context.expected && result.packageDigest !== context.expected) {
      if (context.register !== false) await markChanged(source, context, result.packageDigest);
      throw new VestryError('LOCATION_CHANGED', 'Selected path contains a different package revision.', 5, { expected: context.expected, actual: result.packageDigest });
    }
    if (context.register !== false) await rememberVerified(source, result, context);
    op.result = { ...result, ...(quarantined ? { quarantined: [quarantined] } : {}) }; op.expected = result.packageDigest; op.phase = 'complete'; op.status = 'succeeded'; op.endedAt = new Date().toISOString();
    await save(home, op);
    return { ...op.result, operationId: op.id, path: source, warnings: op.warnings };
  } catch (error) {
    if (context.register !== false && diagnostic(error).exitCode === 3) await markChanged(source, context).catch(() => undefined);
    throw await fail(home, op, error);
  }
}
