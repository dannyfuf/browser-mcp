import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';

// Confirms the MCP stdio transport is uncorrupted: stdout must be pure JSON-RPC,
// every line parseable. Catches stray console.log regressions that the in-process
// tests would miss.
test('MCP stdio transport responds with parseable JSON-RPC', async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const proc = spawn('deno', ['run', '-A', entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER_HEADLESS: '1' },
  });

  let stdout = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'transport-smoke', version: '0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } },
  ];
  for (const m of messages) {
    proc.stdin.write(`${JSON.stringify(m)}\n`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));

  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
    const obj = JSON.parse(line) as { jsonrpc: string };
    expect(obj.jsonrpc).toBe('2.0');
  }
  const responses = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(responses.find((r) => r.id === 1)).toBeDefined();
  expect(responses.find((r) => r.id === 2)).toBeDefined();
  const callResp = responses.find((r) => r.id === 3) as { result?: { content: unknown[] } };
  expect(callResp?.result?.content).toBeDefined();
});

test('SIGTERM drains an active recording to recoverable frames and metadata', async () => {
  const artifactDir = await Deno.makeTempDir({ prefix: 'browser-mcp-sigterm-' });
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const proc = spawn('deno', ['run', '-A', entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER_ARTIFACT_DIR: artifactDir,
      BROWSER_FFMPEG_PATH: '/opt/homebrew/bin/ffmpeg',
      BROWSER_HEADLESS: '1',
    },
  });
  const output = captureJsonRpc(proc);

  try {
    sendMessage(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sigterm-recording-test', version: '0' },
      },
    });
    await waitForResponse(output, 1);
    sendMessage(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const fixture = `<!doctype html>
      <style>
        #box { width: 60px; height: 60px; background: blue; animation: move 0.15s linear infinite alternate; }
        @keyframes move { to { transform: translateX(240px); background: orange; } }
      </style>
      <div id="box"></div>`;
    sendMessage(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: { url: `data:text/html,${encodeURIComponent(fixture)}` },
      },
    });
    await waitForResponse(output, 2);
    sendMessage(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'browser_start_recording', arguments: {} },
    });
    const startResponse = await waitForResponse(output, 3);
    const recordingDir = responseText(startResponse)
      .find((line) => line.startsWith('Recording directory: '))
      ?.slice('Recording directory: '.length);
    expect(recordingDir).toBeDefined();
    await waitForRecordingFrames(recordingDir as string, 2);

    const exitPromise = waitForExit(proc);
    expect(proc.kill('SIGTERM')).toBe(true);
    const exit = await exitPromise;
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);

    const files = await readdir(recordingDir as string);
    expect(files.some((name) => /^frame-\d+\.jpg$/.test(name))).toBe(true);
    expect(files.some((name) => name.endsWith('.webm'))).toBe(false);
    expect((await stat(join(recordingDir as string, 'frames.ndjson'))).size).toBeGreaterThan(0);
    const metadata = (await readFile(join(recordingDir as string, 'frames.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { n: number; ts: number });
    expect(metadata.length).toBeGreaterThanOrEqual(2);
    const manifest = JSON.parse(
      await readFile(join(recordingDir as string, 'recording.json'), 'utf8'),
    ) as { status: string; assembled: boolean; note?: string };
    expect(manifest.status).toBe('unassembled');
    expect(manifest.assembled).toBe(false);
    expect(manifest.note).toContain('assembly skipped during shutdown');
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await rm(artifactDir, { force: true, recursive: true });
  }
});

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: unknown;
}

interface CapturedOutput {
  messages: RpcMessage[];
  stderr: string;
}

function captureJsonRpc(proc: ReturnType<typeof spawn>): CapturedOutput {
  const output: CapturedOutput = { messages: [], stderr: '' };
  let pending = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) output.messages.push(JSON.parse(line) as RpcMessage);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });
  return output;
}

function sendMessage(proc: ReturnType<typeof spawn>, message: Record<string, unknown>): void {
  proc.stdin?.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(
  output: CapturedOutput,
  id: number,
  timeoutMs = 15_000,
): Promise<RpcMessage> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const response = output.messages.find((message) => message.id === id);
    if (response) {
      if (response.error)
        throw new Error(`JSON-RPC ${id} failed: ${JSON.stringify(response.error)}`);
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for JSON-RPC ${id}; stderr: ${output.stderr}`);
}

function responseText(response: RpcMessage): string[] {
  return (
    response.result?.content?.flatMap((content) =>
      content.type === 'text' && content.text ? [content.text] : [],
    ) ?? []
  );
}

async function waitForRecordingFrames(recordingDir: string, expected: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const files = await readdir(recordingDir);
    if (files.filter((name) => /^frame-\d+\.jpg$/.test(name)).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${expected} recording frames landed on disk`);
}

async function waitForExit(
  proc: ReturnType<typeof spawn>,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for subprocess exit')), timeoutMs);
    }),
  ]);
}
