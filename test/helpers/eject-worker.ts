import { ejectPackage } from '../../src/eject.js';
const [source, home, phase] = process.argv.slice(2);
await ejectPackage(source, { home, onPhase: current => { if (current === phase) process.kill(process.pid, 'SIGKILL'); } });
