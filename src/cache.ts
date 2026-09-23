import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, exists, owned, syncPath } from './fs-util.js';
import { walk } from './inventory.js';
import { mtimeNs, restoreMtime } from './timestamps.js';
import { VestryError, conflict, integrity } from './errors.js';
import { homePath, transaction, workspace, type Context } from './operations.js';
import { verify } from './package.js';
import { markChanged, mutateRegistry, overlapping, readRegistry, rememberVerified, resolveIdentity, withCacheMutation, withReference } from './registry.js';
import { checkPackage, verifyRecorded } from './workflow.js';

export function cacheRoot(context: Context): string {
  if (context.home) return join(homePath(context.home), 'cache');
  if (process.platform === 'darwin') return join(homedir(), 'Library/Caches/Vestry');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'Vestry/Cache');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vestry');
}
export async function managedPath(id: string, storage: 'cache' | 'pinned', context: Context): Promise<string> {
  const hex = id.split(':').at(-1)!;
  if (!/^[0-9a-f]{64}$/.test(hex)) throw conflict('Invalid managed package identity.');
  const rawRoot = storage === 'pinned' ? homePath(context.home) : cacheRoot(context);
  const root = join(await canonical(dirname(rawRoot)), basename(rawRoot));
  return join(root, storage === 'pinned' ? 'offline' : 'packages', hex);
}
async function managedParent(path: string): Promise<void> {
  // Managed storage must not redirect deletion through a user-created symlink.
  if (await canonical(path) !== resolve(path)) throw conflict('Managed storage cannot contain symlinked path components.');
  if (await exists(path) && !(await lstat(path)).isDirectory()) throw conflict('Managed storage must be a directory.');
  await mkdir(path, { recursive: true });
}

export async function copyPackage(source: string, destination: string, context: Context): Promise<void> {
  const inventory = await walk(source);
  if (await exists(join(source, 'data'))) await mkdir(join(destination, 'data'));
  for (const item of inventory) {
    context.signal?.throwIfAborted();
    await mkdir(dirname(join(destination, item.path)), { recursive: true });
    await copyFile(join(source, item.path), join(destination, item.path), constants.COPYFILE_EXCL);
    await restoreMtime(join(destination, item.path), await mtimeNs(join(source, item.path)));
  }
}

// Called with exclusive cache admission already held. Only known, correctly
// owned managed directories can be retired. Archive locations are never targets.
async function retire(id: string, storage: 'cache' | 'pinned', context: Context, ownLease?: string): Promise<boolean> {
  const target = await managedPath(id, storage, context);
  if (await canonical(target) !== target) throw conflict('Managed deletion path contains a symlink.');
  let trash: string | undefined;
  const retired = await mutateRegistry(context, [], async state => {
    const location = state.packages[id]?.locations.find(l => l.path === target && l.storage === storage && l.state !== 'evicted');
    if (!location) return false;
    if (state.leases.some(lease => overlapping(lease.path, target) && lease.token !== ownLease)) throw conflict('Managed copy has an active reader; refusing removal.');
    if (await exists(target)) {
      if (!await owned(target, location.owner)) throw conflict('Managed directory was replaced; refusing deletion.');
      trash = join(dirname(target), `.evicted-${randomUUID()}`);
      await rename(target, trash); await syncPath(dirname(target), []);
    }
    location.state = 'evicted'; return true;
  });
  if (trash) await rm(trash, { recursive: true });
  return retired;
}

export async function cacheCopy(ref: string, action: 'add' | 'pin' | 'unpin', context: Context & { offline?: boolean; pin?: boolean; location?: string } = {}): Promise<Record<string, unknown>> {
  return withReference(ref, context, async source => {
    const verified = await verifyRecorded(source.path, { ...context, expected: source.expected });
    const id = verified.packageDigest as string;
    return withCacheMutation(id, source.lease, context, async () => {
      const state = await readRegistry(context);
      const hasPinned = state.packages[id].locations.some(l => l.storage === 'pinned' && l.state !== 'evicted');
      if (action === 'unpin' && !hasPinned) throw conflict('Package is not pinned.');
      const storage = action === 'pin' || action === 'add' && (context.pin || hasPinned) ? 'pinned' : 'cache';
      const destination = await managedPath(id, storage, context);
      await workspace(context, [source.path]);
      await managedParent(dirname(destination));
      let result: Record<string, unknown>;
      if (await exists(destination)) {
        const current = await verify(destination);
        if (current.packageDigest !== id) { await markChanged(destination, context, current.packageDigest); throw integrity('Managed copy has the wrong package identity.'); }
        await rememberVerified(destination, current, context, { storage });
        result = { ...current, path: destination, status: 'verified', reused: true };
      } else {
        result = await transaction('cache-copy', source.path, destination,
          stage => copyPackage(source.path, stage, context), async stage => {
            const check = await checkPackage(stage);
            if (check.identity !== id) throw integrity('Cached copy differs from verified source.');
            return check;
          }, { ...context, storage });
      }
      // A verified replacement is durable before retiring the prior managed
      // representation. Original external locations are never removed.
      if (action === 'pin' || action === 'add' && context.pin) await retire(id, 'cache', context, source.lease);
      if (action === 'unpin') await retire(id, 'pinned', context, source.lease);
      return { ...result, storage, pinned: storage === 'pinned' };
    });
  });
}

export async function cacheList(context: Context = {}): Promise<Record<string, unknown>> {
  const state = await readRegistry(context);
  const copies: Record<string, unknown>[] = [];
  for (const record of Object.values(state.packages)) for (const location of record.locations) {
    if (location.storage === 'external' || location.state === 'evicted') continue;
    copies.push({ contentId: record.payloadDigest, payloadDigest: record.payloadDigest, packageDigest: record.packageDigest, ...location, pinned: location.storage === 'pinned', availability: await exists(location.path) ? location.state === 'changed' ? 'changed' : 'available' : 'unavailable' });
  }
  return { copies };
}

export async function cacheEvict(ref: string, context: Context = {}): Promise<Record<string, unknown>> {
  const state = await readRegistry(context);
  const path = await canonical(resolve(ref));
  const record = Object.values(state.packages).find(p => p.locations.some(l => l.path === path && l.state !== 'evicted'));
  const id = record?.packageDigest ?? resolveIdentity(ref, state);
  return withCacheMutation(id, undefined, context, async () => {
    const latest = await readRegistry(context);
    if (latest.packages[id].locations.some(l => l.storage === 'pinned' && l.state !== 'evicted')) throw conflict('Package is pinned. Run cache unpin before eviction.');
    const retired = await retire(id, 'cache', context);
    if (!retired) throw new VestryError('RESOURCE_UNAVAILABLE', 'No evictable managed copy exists for this package.', 4);
    return { status: 'evicted', contentId: latest.packages[id].payloadDigest, payloadDigest: latest.packages[id].payloadDigest, packageDigest: id };
  });
}
