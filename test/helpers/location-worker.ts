import { convertInPlace, createPackage, movePackage } from '../../src/locations.js';
import type { Context } from '../../src/operations.js';
const [kind, source, destination, home, phase] = process.argv.slice(2);
const context: Context = { home, onPhase: current => { if (current === phase) process.kill(process.pid, 'SIGKILL'); } };
if (kind === 'pack' || kind === 'unpack') await convertInPlace(source, kind === 'pack' ? 'packed' : 'expanded', context);
else if (kind === 'create') await createPackage(source, { ...context, description: 'Crash fixture', alias: 'crash-fixture' });
else await movePackage(source, destination, context);
