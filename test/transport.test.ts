import { spawn } from 'node:child_process';
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
