export interface SmokeOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface SmokeToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface SmokeToolResult {
  call: SmokeToolCall;
  result: unknown;
}

export function runSmoke(command: string[], opts: SmokeOptions): Promise<SmokeToolResult[]> {
  void command;
  void opts;
  return Promise.reject(new Error('not implemented'));
}

async function main(): Promise<void> {
  const command = Deno.args;
  if (command.length === 0) {
    writeStderr('usage: deno run -A smoke/harness.ts <command> [args...]\n');
    Deno.exitCode = 2;
    return;
  }
  await runSmoke(command, {});
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    Deno.exitCode = 1;
  });
}

function writeStderr(message: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(message));
}
