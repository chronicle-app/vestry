export type ExitCode = 1 | 2 | 3 | 4 | 5 | 6 | 130;
export class VestryError extends Error {
  constructor(public code: string, message: string, public exitCode: ExitCode, public details: Record<string, unknown> = {}) { super(message); }
}
export const usage = (message: string) => new VestryError('INVALID_ARGUMENT', message, 2);
export const integrity = (message: string) => new VestryError('INTEGRITY_MISMATCH', message, 3);
export const conflict = (message: string) => new VestryError('STATE_CONFLICT', message, 5);
export function diagnostic(error: unknown): VestryError {
  if (error instanceof VestryError) return error;
  const e = error as NodeJS.ErrnoException;
  if (e?.name === 'AbortError') return new VestryError('INTERRUPTED', 'Operation interrupted; use vestry recover to inspect pending work.', 130);
  if (['EEXIST', 'ENOTEMPTY'].includes(e?.code ?? '')) return conflict(e.message);
  if (['ENOENT', 'ENODEV', 'EACCES', 'EPERM'].includes(e?.code ?? '')) return new VestryError('RESOURCE_UNAVAILABLE', e.message, 4);
  return new VestryError('EXECUTION_FAILED', e?.message ?? String(error), 1);
}
