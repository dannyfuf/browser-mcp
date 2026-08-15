import { Buffer } from 'node:buffer';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface ToolCallResult {
  content?: Array<{ type?: string; data?: string; mimeType?: string; text?: string }>;
  isError?: boolean;
}

const encoder = new TextEncoder();
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function runSmoke(
  command: string[],
  opts: SmokeOptions = {},
): Promise<SmokeToolResult[]> {
  if (command.length === 0) throw new Error('smoke command must not be empty');

  const fixture = startFixtureServer();
  const temporaryArtifactDir = opts.env?.BROWSER_ARTIFACT_DIR === undefined;
  const artifactDir =
    opts.env?.BROWSER_ARTIFACT_DIR ?? (await Deno.makeTempDir({ prefix: 'browser-mcp-smoke-' }));
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    env: childEnvironment({ ...opts.env, BROWSER_ARTIFACT_DIR: artifactDir }),
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  const responses = new Map<number, JsonRpcResponse>();
  const diagnostics = { stderr: '' };
  const stdoutDone = captureResponses(child.stdout, responses);
  const stderrDone = captureStderr(child.stderr, diagnostics);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let nextId = 1;

  const send = async (message: Record<string, unknown>): Promise<void> => {
    await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
  };
  const request = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    await send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const response = await waitForResponse(responses, id, timeoutMs, diagnostics);
    if (response.error !== undefined) {
      throw new Error(`JSON-RPC ${method} failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  };
  const callTool = async (call: SmokeToolCall): Promise<SmokeToolResult> => {
    const result = (await request('tools/call', {
      name: call.name,
      arguments: call.arguments ?? {},
    })) as ToolCallResult;
    if (result.isError) {
      throw new Error(`${call.name} returned an MCP tool error: ${JSON.stringify(result.content)}`);
    }
    return { call, result };
  };

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'browser-mcp-smoke', version: '1' },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const results: SmokeToolResult[] = [];
    results.push(await callTool({ name: 'browser_new_tab' }));
    results.push(await callTool({ name: 'browser_start_recording' }));
    results.push(await callTool({ name: 'browser_navigate', arguments: { url: fixture.url } }));
    results.push(await callTool({ name: 'browser_click', arguments: { selector: '#interact' } }));
    results.push(
      await callTool({
        name: 'browser_evaluate',
        arguments: {
          expression:
            'new Promise((resolve) => setTimeout(() => resolve(document.querySelector("#fixture")?.textContent), 500))',
        },
      }),
    );
    const recording = await callTool({ name: 'browser_stop_recording' });
    await assertRecordingArtifact(recording.result as ToolCallResult);
    results.push(recording);
    const screenshot = await callTool({ name: 'browser_screenshot' });
    assertPng(screenshot.result as ToolCallResult);
    results.push(screenshot);
    results.push(await callTool({ name: 'browser_close' }));
    return results;
  } finally {
    await fixture.stop();
    await writer.close().catch(() => {});
    await stopChild(child, opts.timeoutMs ?? 10_000);
    await Promise.allSettled([stdoutDone, stderrDone]);
    if (temporaryArtifactDir) await rm(artifactDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const command = Deno.args;
  if (command.length === 0) {
    writeStderr('usage: deno run -A smoke/harness.ts <command> [args...]\n');
    Deno.exitCode = 2;
    return;
  }
  const results = await runSmoke(command);
  writeStderr(`smoke passed (${results.length} tool calls)\n`);
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

function childEnvironment(overrides: SmokeOptions['env']): Record<string, string> {
  const env = Deno.env.toObject();
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

function startFixtureServer(): { url: string; stop: () => Promise<void> } {
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
    () =>
      new Response(
        `<!doctype html><html><head><style>
          #fixture { animation: pulse 0.2s linear infinite alternate; }
          @keyframes pulse { to { transform: translateX(40px); color: rebeccapurple; } }
        </style></head><body>
          <h1 id="fixture">browser-mcp smoke</h1>
          <button id="interact" onclick="document.querySelector('#fixture').textContent = 'recorded interaction'">Interact</button>
        </body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  );
  const address = server.addr as Deno.NetAddr;
  return {
    url: `http://${address.hostname}:${address.port}/fixture`,
    stop: () => server.shutdown(),
  };
}

async function assertRecordingArtifact(result: ToolCallResult): Promise<void> {
  const webmPath = result.content
    ?.find((item) => item.text?.startsWith('WebM path: '))
    ?.text?.slice('WebM path: '.length);
  const framesDir = result.content
    ?.find((item) => item.text?.startsWith('Frames directory: '))
    ?.text?.slice('Frames directory: '.length);
  const recordingDir = webmPath ? dirname(webmPath) : framesDir;
  if (!recordingDir) throw new Error('browser_stop_recording returned no artifact path');

  const metadata = await Promise.all([
    stat(join(recordingDir, 'frames.ndjson')),
    stat(join(recordingDir, 'recording.json')),
  ]);
  if (metadata.some((entry) => !entry.isFile() || entry.size === 0)) {
    throw new Error('recording metadata artifacts were empty');
  }

  if (webmPath) {
    const webm = await stat(webmPath);
    if (!webm.isFile() || webm.size === 0) throw new Error('recording WebM artifact was empty');
    return;
  }

  const frames = (await readdir(recordingDir)).filter((name) => /^frame-\d+\.jpg$/.test(name));
  if (frames.length === 0) throw new Error('recording fallback produced no JPEG frame artifacts');
}

async function captureResponses(
  stream: ReadableStream<Uint8Array>,
  responses: Map<number, JsonRpcResponse>,
): Promise<void> {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) responses.set(message.id, message);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const message = JSON.parse(pending) as JsonRpcResponse;
    if (message.id !== undefined) responses.set(message.id, message);
  }
}

async function captureStderr(
  stream: ReadableStream<Uint8Array>,
  diagnostics: { stderr: string },
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    diagnostics.stderr += decoder.decode(chunk, { stream: true });
  }
  diagnostics.stderr += decoder.decode();
}

async function waitForResponse(
  responses: Map<number, JsonRpcResponse>,
  id: number,
  timeoutMs: number,
  diagnostics: { stderr: string },
): Promise<JsonRpcResponse> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const response = responses.get(id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for JSON-RPC ${id}; stderr: ${diagnostics.stderr}`);
}

function assertPng(result: ToolCallResult): void {
  const image = result.content?.find(
    (content) => content.type === 'image' && content.mimeType === 'image/png',
  );
  if (!image?.data) throw new Error('browser_screenshot returned no base64 PNG');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length <= PNG_SIGNATURE.length) throw new Error('browser_screenshot PNG was empty');
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('browser_screenshot returned invalid PNG bytes');
  }
}

async function stopChild(child: Deno.ChildProcess, timeoutMs: number): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const terminated = await childStatusWithin(child, timeoutMs);
  if (!terminated) child.kill('SIGKILL');
  await child.status;
}

async function childStatusWithin(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<Deno.CommandStatus | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.status,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
