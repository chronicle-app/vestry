import { randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { atomicJson, canonical, exists, outside, owned, owner, syncPath, syncTree, type Owner } from './fs-util.js';
import { VestryError, conflict, diagnostic, integrity, usage } from './errors.js';

export type Phase = 'planned' | 'building' | 'verified' | 'relocated' | 'reserved' | 'published' | 'cleaning' | 'complete' | 'discarded';
export interface Operation {
  schemaVersion: 1; id: string; kind: 'seal' | 'gather' | 'pack' | 'unpack' | 'verify' | 'cache-copy' | 'create' | 'move' | 'copy' | 'eject' | 'import-zip';
  storage?: 'cache' | 'pinned';
  source: string; destination?: string; staging?: string; stageOwner?: Owner; reservation?: Owner;
  phase: Phase; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'discarded';
  pid: number; host: string; startedAt: string; endedAt?: string;
  expected?: string; result?: Record<string, unknown>; warnings: string[]; error?: { code: string; message: string };
  sourceOwner?: Owner; sourceIdentity?: string; backup?: string; backupReservation?: Owner;
  retainOriginal?: boolean;
  cleanupStarted?: boolean; sourceRetired?: boolean;
  timings?: { stage: string; seconds: number }[];
  ejectPackageDigest?: string;
  zipAdoption?: import('./zip-adoption.js').ZipAdoption;
  zipEntry?: string;
  catalogMetadata?: import('./registry.js').VestryMetadata;
  alias?: string;
  inPlace?: boolean;
}
export interface Context {
  resumeCreation?: boolean;
  onActivity?: (message: string, bytes?: string, total?: string) => void;
  onRead?: (path: string) => void;
  quarantined?: import('./quarantine.js').QuarantineReport[];
  home?: string; signal?: AbortSignal;
  expected?: string; storage?: 'cache' | 'pinned';
  ejectPackageDigest?: string;
  adoptZip?: boolean;
  zipEntry?: string;
  catalogMetadata?: import('./registry.js').VestryMetadata;
  alias?: string;
  inPlace?: boolean;
  onPhase?: (phase: Phase, operation: Operation) => void | Promise<void>;
}
export function homePath(value?: string): string {
  if (value) return resolve(value);
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Vestry');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'Vestry');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'vestry');
}
export async function workspace(context: Context, roots: string[]): Promise<string> {
  const home = await canonical(homePath(context.home));
  await outside(home, roots);
  for (let p = home; ; p = dirname(p)) {
    if (await exists(join(p, 'bagit.txt')) || await exists(join(p, '.vestry-draft.json'))) throw conflict('Application workspace must be outside packages and drafts.');
    if (dirname(p) === p) break;
  }
  const operations = join(home, 'operations');
  if (await exists(operations) && !(await lstat(operations)).isDirectory()) throw conflict('Operation storage must be a regular directory.');
  await mkdir(operations, { recursive: true });
  return home;
}
export const recordPath = (home: string, id: string) => join(home, 'operations', id, 'operation.json');
export async function save(home: string, op: Operation): Promise<void> { await atomicJson(recordPath(home, op.id), op, op.warnings); }
export async function checkpoint(home: string, op: Operation, phase: Phase, context: Context): Promise<void> {
  context.signal?.throwIfAborted(); op.phase = phase; await save(home, op);
  await context.onPhase?.(phase, op); context.signal?.throwIfAborted();
}
function alive(op: Operation): boolean {
  if (op.host !== hostname()) throw conflict('Operation belongs to another host; recover it on that host.');
  try { process.kill(op.pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; return true; }
}
export async function newOperation(home: string, kind: Operation['kind'], source: string, destination?: string, storage?: 'cache' | 'pinned'): Promise<Operation> {
  if (kind === 'cache-copy' && !storage || kind !== 'cache-copy' && storage) throw usage('Managed storage must be specified only for cache-copy operations.');
  const op: Operation = { schemaVersion: 1, id: randomUUID(), kind, source, phase: 'planned', status: 'running', pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), warnings: [] };
  if (destination) { op.destination = destination; op.staging = join(dirname(destination), `.vestry-${op.id}.tmp`); }
  if (storage) op.storage = storage;
  await mkdir(dirname(recordPath(home, op.id))); await save(home, op); return op;
}
export async function fail(home: string, op: Operation, error: unknown): Promise<VestryError> {
  const failure = diagnostic(error);
  op.status = failure.exitCode === 130 ? 'interrupted' : 'failed'; op.endedAt = new Date().toISOString();
  op.error = { code: failure.code, message: failure.message };
  try { await save(home, op); }
  catch (saveError) { failure.details.journalError = diagnostic(saveError).message; }
  failure.details.operationId = op.id; failure.details.home = home;
  return failure;
}
export type Checked = { identity: string; result: Record<string, unknown> };

async function checkOriginal(path: string, op: Operation, context: Context): Promise<void> {
  if (!await owned(path, op.sourceOwner)) throw conflict('Original directory was replaced; refusing relocation or removal.');
  const { digest, walk } = await import('./inventory.js');
  if (digest('code', await walk(path, '', new Set(), (file, bytes, total) => context.onActivity?.(`Rechecking original: ${file}`, bytes, total))) !== op.sourceIdentity) throw integrity('Original files changed during the operation; they have been retained.');
}

async function relocateOriginal(home: string, op: Operation, context: Context): Promise<void> {
  if (!op.backup || !op.sourceIdentity || !op.sourceOwner) throw conflict('Missing original ownership record.');
  if (await owned(op.backup, op.sourceOwner)) { await checkOriginal(op.backup, op, context); return; }
  await checkOriginal(op.source, op, context);
  if (!op.backupReservation) {
    await mkdir(op.backup, { mode: 0o700 }); op.backupReservation = await owner(op.backup);
    await syncPath(dirname(op.backup), op.warnings); await save(home, op);
  }
  if (!await owned(op.backup, op.backupReservation) || (await readdir(op.backup)).length) throw conflict('Original backup reservation changed.');
  context.signal?.throwIfAborted();
  await rename(op.source, op.backup);
  await syncPath(dirname(op.source), op.warnings);
  await checkpoint(home, op, 'relocated', context);
}

async function finishRelocation(home: string, op: Operation, context: Context, cleanup = false): Promise<void> {
  const { mutateRegistry } = await import('./registry.js');
  if (op.kind === 'eject') {
    const { checkEjected } = await import('./eject.js');
    if (!await owned(op.destination!, op.stageOwner) || (await checkEjected(op.destination!)).identity !== op.expected) throw integrity('Restored files changed; original package retained.');
    if (!cleanup) {
      await mutateRegistry(context, [], state => {
        const record = state.packages[op.ejectPackageDigest!];
        if (record) {
          record.locations = record.locations.filter(location => location.path !== op.source);
          if (record.mainLocation === op.source) record.mainLocation = null;
        }
      });
      op.result = { ...op.result, packageDigest: op.ejectPackageDigest, recoveryCopy: op.backup, cleanupRequired: !op.sourceRetired };
      return;
    }
  } else if (op.kind !== 'create' && op.kind !== 'move' && !op.inPlace) return;
  if (op.kind !== 'eject') {
    const { verify } = await import('./package.js');
    const { setMainLocation } = await import('./registry.js');
    context.onActivity?.('Rechecking published destination before retiring the original');
    if (!await owned(op.destination!, op.stageOwner)) throw integrity('Published destination changed; original has been retained.');
    const { quarantineFinderFiles } = await import('./quarantine.js');
    await quarantineFinderFiles(op.destination!, { ...context, expected: op.expected });
    if ((await verify(op.destination!)).packageDigest !== op.expected) throw integrity('Published destination changed; original has been retained.');
    if (!op.inPlace && !cleanup) await setMainLocation(op.expected!, op.destination!, context, op.kind === 'create');
  }
  if (op.sourceRetired) return;
  if (op.kind === 'move' && op.retainOriginal && !cleanup) {
    await relocateOriginal(home, op, context);
    await mutateRegistry(context, [], state => {
      const record = state.packages[op.expected!];
      record.locations = record.locations.filter(location => location.path !== op.source);
    });
    op.result = { ...op.result, recoveryCopy: op.backup, cleanupRequired: true };
    return;
  }
  if (!op.cleanupStarted) {
    if (op.kind === 'move') await relocateOriginal(home, op, context);
    await checkOriginal(op.backup!, op, context);
    if (op.zipEntry) {
      const { preserveZipFolderFinderFile } = await import('./quarantine.js');
      if (await preserveZipFolderFinderFile(op.backup!, { ...context, expected: op.expected })) await checkOriginal(op.backup!, op, context);
    }
    op.cleanupStarted = true;
    await checkpoint(home, op, 'cleaning', context);
  }
  // Only the recorded, hidden original directory is eligible for cleanup.
  // A saved checkpoint permits resuming a partially completed recursive removal.
  if (await exists(op.backup!)) {
    if (!await owned(op.backup!, op.sourceOwner)) throw conflict('Original backup was replaced; refusing cleanup.');
    await rm(op.backup!, { recursive: true });
    await syncPath(dirname(op.backup!), op.warnings);
  }
  if (op.kind === 'move' && !op.retainOriginal) await mutateRegistry(context, [], state => {
    const record = state.packages[op.expected!];
    record.locations = record.locations.filter(location => location.path !== op.source);
  });
  op.sourceRetired = true; await save(home, op);
}

async function publish(home: string, op: Operation, context: Context): Promise<void> {
  const destination = op.destination!, staging = op.staging!;
  if (!await owned(staging, op.stageOwner)) throw conflict('Staging directory ownership changed.');
  if (op.kind === 'create' || op.kind === 'eject' || op.inPlace) await relocateOriginal(home, op, context);
  if (!op.reservation) {
    // mkdir is the no-clobber claim. Rename only replaces our recorded empty
    // reservation, never an existing user destination. Concurrent Vestry jobs
    // cannot acquire the same destination, even with different --home values.
    await mkdir(destination, { mode: 0o700 });
    op.reservation = await owner(destination);
    await syncPath(dirname(destination), op.warnings);
    await checkpoint(home, op, 'reserved', context);
  }
  if (!await owned(destination, op.reservation) || (await readdir(destination)).length !== 0) throw conflict('Destination reservation changed; refusing publication.');
  context.signal?.throwIfAborted();
  await rename(staging, destination);
  await syncPath(dirname(destination), op.warnings);
  await checkpoint(home, op, 'published', context);
}

export async function transaction(kind: Operation['kind'], source: string, destination: string, build: (staging: string) => Promise<void>, check: (root: string) => Promise<Checked>, context: Context = {}): Promise<Record<string, unknown>> {
  source = await canonical(source);
  destination = await canonical(destination);
  if (context.inPlace && !['pack', 'unpack'].includes(kind)) throw usage('In-place conversion is only valid for pack/unpack.');
  if (kind === 'create' || kind === 'eject' || context.inPlace) {
    if (source !== destination) throw conflict('In-place creation must retain the source path.');
  } else {
    await outside(destination, [source]);
    if (await exists(destination)) throw conflict(`Destination exists: ${destination}`);
  }
  const home = await workspace(context, [source, destination]);
  const op = await newOperation(home, kind, await canonical(source), destination, context.storage);
  if (kind === 'import-zip' || context.zipEntry) op.timings = [];
  let stageStarted = performance.now();
  const timed = (stage: string) => {
    const now = performance.now();
    op.timings?.push({ stage, seconds: (now - stageStarted) / 1000 });
    stageStarted = now;
  };
  try {
    if (kind === 'eject') { op.ejectPackageDigest = context.ejectPackageDigest; op.retainOriginal = true; }
    if (context.zipEntry) op.zipEntry = context.zipEntry;
    if (kind === 'move') op.retainOriginal = true;
    if (context.inPlace) op.inPlace = true;
    if (kind === 'create' || kind === 'move' || kind === 'eject' || op.inPlace) {
      const { digest, walk } = await import('./inventory.js');
      context.onActivity?.('Reading original files before copying');
      op.sourceOwner = await owner(source);
      const originals = await walk(source, '', new Set(), (path, bytes, total) => context.onActivity?.(`Reading original: ${path}`, bytes, total));
      if (op.zipEntry && (originals.filter(item => item.path !== '.DS_Store').length !== 1 || !originals.some(item => item.path === op.zipEntry))) throw conflict('ZIP folder contents changed before creation; original files retained.');
      op.sourceIdentity = digest('code', originals);
      op.backup = join(dirname(source), `.vestry-${op.id}.original`);
    }
    if (context.catalogMetadata) op.catalogMetadata = context.catalogMetadata;
    if (['create', 'import-zip'].includes(kind) && context.alias) op.alias = context.alias;
    timed('Inspect original');
    await checkpoint(home, op, 'planned', context);
    await mkdir(op.staging!, { mode: 0o700 }); op.stageOwner = await owner(op.staging!);
    await checkpoint(home, op, 'building', context);
    if (context.adoptZip) {
      const { prepareZipAdoption, relocateZip } = await import('./zip-adoption.js');
      const prepared = await prepareZipAdoption(source, op.staging!, context);
      op.zipAdoption = prepared.archive; op.expected = prepared.result.packageDigest; op.result = { ...prepared.result, sourceRetained: false, sourceMoved: true };
      await syncTree(op.staging!, op.warnings);
      // Persist the identity and original inode before any source rename.
      await checkpoint(home, op, 'verified', context);
      await relocateZip(home, op, context);
    } else await build(op.staging!);
    context.signal?.throwIfAborted();
    timed(context.adoptZip ? 'Read ZIP and move unchanged archive' : 'Copy ZIP and inventory contents');
    context.onActivity?.('Verifying the staged copy');
    if (kind !== 'gather' && kind !== 'eject') {
      const { quarantineFinderFiles } = await import('./quarantine.js');
      await quarantineFinderFiles(op.staging!, context);
    }
    const checked = await check(op.staging!);
    if (op.zipAdoption && checked.identity !== op.expected) throw integrity('Moved ZIP differs from the prepared package; retained in staging for recovery.');
    op.expected = checked.identity; op.result = { ...checked.result, ...(op.zipAdoption ? { sourceRetained: false, sourceMoved: true } : {}) };
    timed('Verify staged package');
    context.onActivity?.('Flushing the verified copy to storage');
    await syncTree(op.staging!, op.warnings);
    timed('Flush destination');
    await checkpoint(home, op, 'verified', context);
    await publish(home, op, context);
    timed('Recheck original and publish');
    if (kind === 'copy') {
      const published = await check(destination);
      if (!await owned(destination, op.stageOwner) || published.identity !== op.expected) throw integrity('Published copy changed; original retained.');
    }
    await registerPublished(op, { ...context, home });
    await finishRelocation(home, op, { ...context, home });
    timed('Verify published package and retire original');
    op.status = 'succeeded'; op.endedAt = new Date().toISOString();
    await checkpoint(home, op, 'complete', context);
    return { ...op.result, operationId: op.id, warnings: op.warnings, path: destination, ...(op.timings ? { timings: op.timings } : {}) };
  } catch (error) { throw await fail(home, op, error); }
}

export async function listOperations(context: Context = {}): Promise<Operation[]> {
  const home = homePath(context.home), directory = join(home, 'operations');
  if (!await exists(directory)) return [];
  const operations: Operation[] = [];
  for (const id of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    if (await exists(recordPath(home, id))) operations.push(await loadOperation(home, id));
  }
  return operations.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
/** Retire only pre-publication attempts whose temporary work is demonstrably gone.
 * This updates history only: it never removes or adopts user files.
 */
export async function retireAbandoned(id: string, context: Context = {}): Promise<boolean> {
  const home = homePath(context.home);
  const eligible = async (op: Operation) => {
    if (['succeeded', 'discarded'].includes(op.status)) return false;
    if (op.host !== hostname() || op.kind === 'verify' || !['planned', 'building'].includes(op.phase) || op.expected || op.zipAdoption || op.reservation || op.backupReservation || op.cleanupStarted || op.sourceRetired) return false;
    if (op.status === 'running' && alive(op)) return false;
    // A missing mounted volume must not look like manually removed staging.
    for (const path of new Set([op.source, op.destination!, op.staging!, op.backup].filter(Boolean))) {
      if (!await exists(dirname(path!)) || !(await lstat(dirname(path!))).isDirectory()) return false;
    }
    if (await exists(op.staging!) || op.backup && await exists(op.backup)) return false;
    if (await exists(op.destination!)) {
      if (op.destination !== op.source || !op.sourceOwner || !(await lstat(op.source)).isDirectory() || !await owned(op.source, op.sourceOwner)) return false;
    }
    return true;
  };
  if (!await eligible(await loadOperation(home, id))) return false;
  const lock = join(dirname(recordPath(home, id)), 'recovery.lock');
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try {
    await atomicJson(join(lock, 'owner.json'), { pid: process.pid, host: hostname() });
    const op = await loadOperation(home, id);
    if (!await eligible(op)) return false;
    op.status = 'discarded'; op.phase = 'discarded'; op.endedAt = new Date().toISOString();
    op.result = { ...op.result, status: 'discarded', reason: 'Temporary work removed before publication; abandoned journal retired automatically.' };
    await save(home, op);
    context.onActivity?.(`Cleared abandoned ${op.kind} attempt; its temporary files were already removed`);
    return true;
  } finally { await rm(join(lock, 'owner.json'), { force: true }); await rmdir(lock); }
}

async function loadOperation(home: string, id: string): Promise<Operation> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw usage('Invalid operation ID.');
  let op: Operation;
  try { op = JSON.parse(await readFile(recordPath(home, id), 'utf8')); }
  catch (e) { if (e instanceof SyntaxError) throw usage('Malformed operation record.'); throw e; }
  if (!op || op.schemaVersion !== 1 || op.id !== id || !['gather', 'seal', 'pack', 'unpack', 'verify', 'cache-copy', 'create', 'move', 'copy', 'eject', 'import-zip'].includes(op.kind) ||
      !['planned', 'building', 'verified', 'relocated', 'reserved', 'published', 'cleaning', 'complete', 'discarded'].includes(op.phase) ||
      !['running', 'succeeded', 'failed', 'interrupted', 'discarded'].includes(op.status) ||
      !Number.isSafeInteger(op.pid) || op.pid <= 0 || typeof op.host !== 'string' || typeof op.source !== 'string' ||
      typeof op.startedAt !== 'string' || !Array.isArray(op.warnings)) throw usage('Invalid operation record.');
  if (op.kind !== 'verify' && (!op.destination || !op.staging)) throw usage('Operation record is missing publication paths.');
  if (op.kind === 'cache-copy' && !op.storage || op.storage !== undefined && !['cache', 'pinned'].includes(op.storage)) throw usage('Invalid managed storage in operation record.');
  if (op.expected && !/^vestry-(package|code)-v1:sha256:[0-9a-f]{64}$/.test(op.expected)) throw usage('Invalid recorded identity.');
  if (op.destination && (resolve(op.destination) !== op.destination || op.staging !== join(dirname(op.destination), `.vestry-${id}.tmp`))) throw conflict('Invalid recorded staging/destination paths.');
  if (op.backup && (op.backup !== join(dirname(op.source), `.vestry-${id}.original`) || !['create', 'move', 'eject'].includes(op.kind) && !op.inPlace)) throw conflict('Invalid original backup path.');
  if (op.kind === 'eject' && (!op.ejectPackageDigest || !/^vestry-package-v1:sha256:[0-9a-f]{64}$/.test(op.ejectPackageDigest))) throw usage('Missing original package identity for eject.');
  if (op.zipAdoption && (op.kind !== 'import-zip' || !op.expected || !/^[0-9a-f]{64}$/.test(op.zipAdoption.sha256) || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => /^-?[0-9]+$/.test(String(op.zipAdoption![key as keyof typeof op.zipAdoption]))))) throw usage('Invalid ZIP adoption record.');
  if (op.zipEntry !== undefined && (op.kind !== 'create' || !/^[^/\\]+\.zip$/i.test(op.zipEntry))) throw usage('Invalid ZIP folder creation record.');
  if (op.retainOriginal !== undefined && (op.retainOriginal !== true || !['move', 'eject'].includes(op.kind))) throw usage('Invalid original retention policy.');
  if (op.inPlace !== undefined && (op.inPlace !== true || !['pack', 'unpack'].includes(op.kind))) throw usage('Invalid in-place conversion record.');
  if ((op.kind === 'create' || op.kind === 'eject' || op.inPlace) && op.source !== op.destination) throw conflict('Invalid in-place operation paths.');
  if (op.alias !== undefined && (!['create', 'import-zip'].includes(op.kind) || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(op.alias))) throw usage('Invalid recorded alias.');
  return op;
}

async function registerPublished(op: Operation, context: Context): Promise<void> {
  if (op.kind === 'gather' || op.kind === 'verify' || op.kind === 'eject') return;
  if (op.kind === 'cache-copy') {
    const { managedPath } = await import('./cache.js');
    if (op.destination !== await managedPath(op.expected!, op.storage!, context)) throw conflict('Cache publication does not match its managed destination.');
  }
  const { rememberVerified } = await import('./registry.js');
  await rememberVerified(op.destination!, op.result as unknown as import('./package.js').Verification, context, { storage: op.storage, alias: op.alias, metadata: op.catalogMetadata, originalZipName: op.zipEntry ?? (op.kind === 'import-zip' ? basename(op.source) : undefined) });
}

export async function recover(id: string, check: (root: string, kind: Operation['kind']) => Promise<Checked>, context: Context = {}, discard = false, releaseLock = false): Promise<Record<string, unknown>> {
  const op = await loadOperation(homePath(context.home), id);
  if ((op.kind === 'create' || op.kind === 'eject' || op.inPlace || op.zipAdoption) && !['succeeded', 'discarded'].includes(op.status) && !releaseLock) {
    const { withPathMutation } = await import('./registry.js');
    return withPathMutation(op.source, context, () => op.zipAdoption
      ? withPathMutation(op.destination!, context, () => recoverOperation(id, check, context, discard, releaseLock))
      : recoverOperation(id, check, context, discard, releaseLock));
  }
  if (['cache-copy', 'move'].includes(op.kind) && op.expected && !['succeeded', 'discarded'].includes(op.status) && !releaseLock) {
    const { withCacheMutation } = await import('./registry.js');
    return withCacheMutation(op.expected, undefined, context, () => recoverOperation(id, check, context, discard, releaseLock));
  }
  return recoverOperation(id, check, context, discard, releaseLock);
}

async function recoverOperation(id: string, check: (root: string, kind: Operation['kind']) => Promise<Checked>, context: Context, discard: boolean, releaseLock: boolean): Promise<Record<string, unknown>> {
  const home = homePath(context.home);
  let op = await loadOperation(home, id);
  if (op.status === 'succeeded' || op.status === 'discarded') return { ...op.result, operationId: id, status: op.status, path: op.destination };
  await workspace(context, [op.source, ...(op.destination ? [op.destination] : [])]);
  if (op.status === 'running' && alive(op)) throw conflict('Operation is still active; wait for it to finish or interrupt it first.');
  const lock = join(dirname(recordPath(home, id)), 'recovery.lock');
  if (releaseLock) {
    const holder = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { pid: number; host: string };
    if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.host !== 'string') throw conflict('Invalid recovery lock owner.');
    if (alive({ ...op, ...holder })) throw conflict('Recovery lock is held by a live process.');
    await rm(join(lock, 'owner.json')); await rmdir(lock);
    return { operationId: id, status: 'lock-released', message: 'Recovery lock released. Rerun recover for this operation.' };
  }
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('Recovery is locked. If its process was killed, use recover ID --release-lock; live owners cannot be unlocked.'); throw error; }
  // Never break recovery locks based on age. Explicit release checks the host
  // and PID, and fails closed if the owner record is missing or PID was reused.
  await atomicJson(join(lock, 'owner.json'), { pid: process.pid, host: hostname() });
  try {
    op = await loadOperation(home, id);
    if (op.status === 'succeeded' || op.status === 'discarded') return { ...op.result, operationId: id, status: op.status, path: op.destination };
    if (op.kind === 'verify') {
      op.status = discard ? 'discarded' : 'interrupted'; op.phase = discard ? 'discarded' : op.phase;
      op.endedAt = new Date().toISOString(); await save(home, op);
      return { operationId: id, status: op.status, message: 'Previous verification did not establish validity; run verify again.' };
    }
    if (op.zipAdoption && !await owned(op.destination!, op.stageOwner)) {
      const { relocateZip } = await import('./zip-adoption.js');
      if (discard) {
        if (!await exists(op.source) || await exists(join(op.staging!, 'data.zip'))) throw conflict('The original ZIP may have moved into staging. Resume recovery; discard cannot remove it.');
      } else await relocateZip(home, op, context);
    }
    const checkRecovered = async (path: string) => {
      if (op.kind !== 'gather' && op.kind !== 'eject') {
        const { quarantineFinderFiles } = await import('./quarantine.js');
        await quarantineFinderFiles(path, { ...context, expected: op.expected });
      }
      return check(path, op.kind);
    };
    // A retry can promote a completed but not yet verified creation only by
    // checking both the original snapshot and the staged logical payload.
    if (!discard && context.resumeCreation && op.kind === 'create' && op.phase === 'building' && !op.expected) {
      if (!await owned(op.source, op.sourceOwner) || !await owned(op.staging!, op.stageOwner)) throw conflict('Original or staging was replaced; refusing automatic recovery.');
      const { digest, walk } = await import('./inventory.js');
      context.onActivity?.('Checking original files against the interrupted creation');
      const original = await walk(op.source, '', new Set(), (path, bytes, total) => context.onActivity?.(`Checking original: ${path}`, bytes, total));
      if (digest('code', original) !== op.sourceIdentity) throw integrity('Original files changed since the interrupted creation. They have been retained.');
      const actual = await checkRecovered(op.staging!);
      let payload = digest('payload', original.map(item => ({ ...item, path: 'data/' + item.path })));
      if (op.zipEntry) {
        const zipOriginal = original.find(item => item.path === op.zipEntry);
        if (original.filter(item => item.path !== '.DS_Store').length !== 1 || !zipOriginal) throw integrity('ZIP folder source no longer contains exactly the recorded archive.');
        const { hashFile } = await import('./inventory.js');
        const archive = await hashFile(join(op.staging!, 'data.zip'), 'data.zip');
        if (archive.sha256 !== zipOriginal.sha256 || archive.size !== zipOriginal.size) throw integrity('Staged ZIP differs from original archive.');
        // Full staged verification already checked every ZIP member and its manifest.
        payload = actual.result.payloadDigest as string;
      }
      if (actual.result.payloadDigest !== payload) throw integrity('Staged payload does not match the original files. Original retained.');
      op.expected = actual.identity; op.result = actual.result;
      await syncTree(op.staging!, op.warnings);
      await checkpoint(home, op, 'verified', context);
    }
    // If rename completed but journal commit did not, verify the exact owned
    // directory and expected identity before recognizing successful publication.
    if (op.expected && await owned(op.destination!, op.stageOwner)) {
      const actual = await checkRecovered(op.destination!);
      if (actual.identity !== op.expected) throw integrity('Published package differs from the recorded identity.');
      op.result = actual.result; op.phase = 'complete'; op.status = 'succeeded';
    } else if (discard) {
      const originalIntact = (op.kind === 'create' || op.kind === 'eject' || op.inPlace) && (await owned(op.source, op.sourceOwner) || !op.stageOwner && !op.expected);
      if (op.backup && await owned(op.backup, op.sourceOwner)) throw conflict('Original has been relocated. Resume recovery to finish publication; discard cannot remove the original.');
      if (!originalIntact && await exists(op.destination!) && (!await owned(op.destination!, op.reservation) || (await readdir(op.destination!)).length !== 0)) throw conflict('Cannot discard an unowned or nonempty destination.');
      if (await exists(op.staging!)) {
        if (!await owned(op.staging!, op.stageOwner)) throw conflict('Cannot discard an unowned staging directory.');
        await rm(op.staging!, { recursive: true });
      }
      if (!originalIntact && await exists(op.destination!)) {
        await rmdir(op.destination!); // Never recursively remove a destination.
      }
      if (op.backup && await exists(op.backup)) {
        if (!await owned(op.backup, op.backupReservation) || (await readdir(op.backup)).length) throw conflict('Cannot discard an unowned or nonempty original backup reservation.');
        await rmdir(op.backup);
      }
      op.phase = 'discarded'; op.status = 'discarded';
    } else {
      if (!op.expected || !['verified', 'relocated', 'reserved', 'published'].includes(op.phase)) throw conflict('Build did not reach verified staging. Use recover ID --discard, then rerun the command.');
      if (!await owned(op.staging!, op.stageOwner)) throw conflict('Verified staging directory is missing or replaced.');
      const actual = await checkRecovered(op.staging!);
      if (actual.identity !== op.expected) throw integrity('Staging content differs from the recorded identity.');
      context.onActivity?.('Flushing the verified copy to storage');
      await syncTree(op.staging!, op.warnings);
      await publish(home, op, context);
      op.result = actual.result; op.phase = 'complete'; op.status = 'succeeded';
    }
    if (op.status === 'succeeded') {
      if (op.zipAdoption) op.result = { ...op.result, sourceRetained: false, sourceMoved: true };
      op.status = 'running';
      await registerPublished(op, context);
      await finishRelocation(home, op, context);
      op.phase = 'complete'; op.status = 'succeeded';
    }
    op.endedAt = new Date().toISOString(); delete op.error; await save(home, op);
    return { ...op.result, operationId: id, status: op.status, path: op.destination, warnings: op.warnings };
  } catch (error) { throw await fail(home, op, error); }
  finally { await rm(join(lock, 'owner.json'), { force: true }); await rmdir(lock); }
}

// Explicit retirement only: recovery of a retained move never authorizes deletion.
export async function cleanupMove(id: string, context: Context = {}): Promise<Record<string, unknown>> {
  const home = homePath(context.home);
  const initial = await loadOperation(home, id);
  if (!['move', 'eject'].includes(initial.kind) || !initial.retainOriginal || initial.status !== 'succeeded' || !initial.expected) throw conflict('Cleanup requires a completed move or eject. Recover unfinished moves first.');
  const { withCacheMutation, withPathMutation } = await import('./registry.js');
  const protectOutput = <T>(action: () => Promise<T>) => initial.kind === 'eject' ? withPathMutation(initial.destination!, context, action) : action();
  return withCacheMutation(initial.ejectPackageDigest ?? initial.expected, undefined, context, () => withPathMutation(initial.backup!, context, () => protectOutput(async () => {
    const op = await loadOperation(home, id);
    if (op.sourceRetired) return { operationId: id, status: 'already-cleaned', path: op.destination };
    // Refuse deletion if either this operation or a fresh flush reports limited durability.
    if (op.warnings.length) throw conflict('Move recorded durability warnings; recovery copy retained.');
    await syncTree(op.destination!, op.warnings);
    await syncPath(dirname(op.destination!), op.warnings);
    if (op.warnings.length) { await save(home, op); throw conflict('Destination durability could not be established; recovery copy retained.'); }
    await finishRelocation(home, op, context, true);
    op.result = { ...op.result, cleanupRequired: false, recoveryCopy: undefined };
    op.phase = 'complete'; await save(home, op);
    return { operationId: id, status: 'cleaned', path: op.destination, message: 'Retained original removed after rechecking the destination.' };
  })));
}
