export type ExitCode = 1 | 2 | 3 | 4 | 5 | 6 | 130;
/**
 * A failure a person can act on: what happened, in a few words and no
 * period, and as `hint` what to do about it, in a sentence or two with
 * commands in backticks.
 */
export class VestryError extends Error {
  constructor(public code: string, message: string, public exitCode: ExitCode, public details: Record<string, unknown> = {}, public hint?: string) { super(message); }
}
export const usage = (message: string, hint?: string) => new VestryError('INVALID_ARGUMENT', message, 2, {}, hint);
export const integrity = (message: string, hint?: string) => new VestryError('INTEGRITY_MISMATCH', message, 3, {}, hint);
export const conflict = (message: string, hint?: string) => new VestryError('STATE_CONFLICT', message, 5, {}, hint);
export function diagnostic(error: unknown): VestryError {
  if (error instanceof VestryError) return error;
  const e = error as NodeJS.ErrnoException;
  if (e?.name === 'AbortError') return new VestryError('INTERRUPTED', 'Interrupted', 130, {}, 'Run `vestry recover` to see what was left unfinished.');
  if (['EEXIST', 'ENOTEMPTY'].includes(e?.code ?? '')) return conflict(e.message);
  if (['ENOENT', 'ENODEV', 'EACCES', 'EPERM'].includes(e?.code ?? '')) return new VestryError('RESOURCE_UNAVAILABLE', e.message, 4);
  return new VestryError('EXECUTION_FAILED', e?.message ?? String(error), 1);
}
