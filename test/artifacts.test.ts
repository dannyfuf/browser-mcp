import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect } from '@std/expect';
import { afterAll, afterEach, test } from '@std/testing/bdd';
import { artifactPath, resolveArtifactDir } from '../src/artifacts.ts';
import { session } from '../src/browser.ts';
import { tools } from '../src/tools/registry.ts';

const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;
const tempRoots: string[] = [];

process.env.BROWSER_HEADLESS = '1';

afterEach(() => {
  if (originalArtifactDir === undefined) {
    delete process.env.BROWSER_ARTIFACT_DIR;
  } else {
    process.env.BROWSER_ARTIFACT_DIR = originalArtifactDir;
  }
});

afterAll(async () => {
  await session.close();
  await Promise.all(tempRoots.map((path) => Deno.remove(path, { recursive: true })));
});

async function makeArtifactDir(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'browser-mcp-artifacts-test-' });
  tempRoots.push(root);
  return join(root, 'nested', 'artifacts');
}

test('defaults the artifact directory beneath the OS temp directory', () => {
  delete process.env.BROWSER_ARTIFACT_DIR;

  expect(resolveArtifactDir()).toBe(join(tmpdir(), 'browser-mcp-artifacts'));
});

test('creates a configured artifact directory lazily', async () => {
  const artifactDir = await makeArtifactDir();
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;

  expect(resolveArtifactDir()).toBe(artifactDir);
  expect(existsSync(artifactDir)).toBe(false);

  const path = artifactPath('screenshot', 'png');

  expect(existsSync(artifactDir)).toBe(true);
  expect(dirname(path)).toBe(artifactDir);
});

test('generates collision-free timestamped artifact names', async () => {
  const artifactDir = await makeArtifactDir();
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;

  const first = artifactPath('screenshot', '.png');
  const second = artifactPath('screenshot', '.png');

  expect(first).not.toBe(second);
  expect(basename(first)).toMatch(
    /^screenshot-\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
  );
});

test('browser_screenshot keeps its parameterless inline-only output', async () => {
  const artifactDir = await makeArtifactDir();
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  const screenshot = tools.find((candidate) => candidate.name === 'browser_screenshot');
  if (!screenshot) throw new Error('browser_screenshot is not registered');

  const result = await screenshot.handler({});

  expect(result).toEqual({
    content: [
      {
        type: 'image',
        data: expect.stringMatching(/^iVBOR/),
        mimeType: 'image/png',
      },
    ],
  });
  expect(existsSync(artifactDir)).toBe(false);
});

test('browser_screenshot file mode writes a PNG and returns only its path', async () => {
  const artifactDir = await makeArtifactDir();
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  const screenshot = tools.find((candidate) => candidate.name === 'browser_screenshot');
  if (!screenshot) throw new Error('browser_screenshot is not registered');

  const result = await screenshot.handler({ output: 'file' });

  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  if (result.content[0]?.type !== 'text') throw new Error('expected a text content block');
  expect(dirname(result.content[0].text)).toBe(artifactDir);
  const bytes = await Deno.readFile(result.content[0].text);
  expect(bytes.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('browser_screenshot both mode returns the inline image and file path', async () => {
  const artifactDir = await makeArtifactDir();
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  const screenshot = tools.find((candidate) => candidate.name === 'browser_screenshot');
  if (!screenshot) throw new Error('browser_screenshot is not registered');

  const result = await screenshot.handler({ output: 'both' });

  expect(result.content).toHaveLength(2);
  expect(result.content[0]).toEqual({
    type: 'image',
    data: expect.stringMatching(/^iVBOR/),
    mimeType: 'image/png',
  });
  expect(result.content[1]?.type).toBe('text');
  if (result.content[1]?.type !== 'text') throw new Error('expected a text content block');
  expect(dirname(result.content[1].text)).toBe(artifactDir);
  expect(existsSync(result.content[1].text)).toBe(true);
});
