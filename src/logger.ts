// stdout is the MCP transport; only stderr is safe for diagnostics.
type Level = 'info' | 'warn' | 'error';

function write(level: Level, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? '' : ` ${safeStringify(extra)}`;
  process.stderr.write(`[${ts}] ${level} ${msg}${tail}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
