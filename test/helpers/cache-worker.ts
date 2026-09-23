import { cacheCopy } from '../../src/cache.js';
import { mutateRegistry, withReference } from '../../src/registry.js';
const [action, ref, home] = process.argv.slice(2);
if (action === 'lock') {
  await mutateRegistry({ home }, [], async () => { console.log('ready'); await new Promise<void>(() => { setInterval(() => undefined, 1000); }); });
} else if (action === 'hold') {
  await withReference(ref, { home, offline: true }, async () => {
    console.log('ready');
    await new Promise<void>(() => { setInterval(() => undefined, 1000); });
  });
} else {
  await cacheCopy(ref, 'add', { home, pin: true, onPhase: phase => { if (phase === 'verified') process.kill(process.pid, 'SIGKILL'); } });
}
