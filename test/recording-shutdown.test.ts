import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@std/expect';
import { afterAll, afterEach, beforeEach, test } from '@std/testing/bdd';
import type { Page } from 'puppeteer';
import { session } from '../src/browser.ts';
import { isRecording, startRecording } from '../src/recording.ts';

const missingFfmpegPath = '/definitely/not-installed/browser-mcp-ffmpeg';
const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;
const originalFfmpegPath = process.env.BROWSER_FFMPEG_PATH;

let artifactDir: string;

beforeEach(async () => {
  artifactDir = await Deno.makeTempDir({ prefix: 'browser-mcp-shutdown-' });
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  process.env.BROWSER_FFMPEG_PATH = missingFfmpegPath;
});

afterEach(async () => {
  await session.close();
  await rm(artifactDir, { force: true, recursive: true });
});

afterAll(() => {
  restoreEnvironment('BROWSER_ARTIFACT_DIR', originalArtifactDir);
  restoreEnvironment('BROWSER_FFMPEG_PATH', originalFfmpegPath);
});

test('closeTab finalizes that tab recording before closing its page', async () => {
  const page = await session.getCurrentPage();
  await prepareAnimatedPage(page);
  const tab = session.listTabs().find(({ isCurrent }) => isCurrent);
  expect(tab).toBeDefined();

  const targetId = pageTargetId(page);
  const recording = await startRecording(page, targetId, {});
  await waitForFrames(recording.recordingDir, 2);

  await session.closeTab(tab?.id);

  expect(isRecording(targetId)).toBe(false);
  await expectRecoverableRecording(recording.recordingDir);
});

test('close finalizes recordings for every open tab', async () => {
  const firstPage = await session.getCurrentPage();
  await prepareAnimatedPage(firstPage);
  const firstTargetId = pageTargetId(firstPage);
  const firstRecording = await startRecording(firstPage, firstTargetId, {});
  await waitForFrames(firstRecording.recordingDir, 2);

  const secondTab = await session.newTab();
  const secondPage = await session.getCurrentPage();
  await prepareAnimatedPage(secondPage);
  const secondTargetId = pageTargetId(secondPage);
  const secondRecording = await startRecording(secondPage, secondTargetId, {});

  expect(secondTab.isCurrent).toBe(true);
  await waitForFrames(secondRecording.recordingDir, 2);

  await session.close();

  expect(isRecording(firstTargetId)).toBe(false);
  expect(isRecording(secondTargetId)).toBe(false);
  await Promise.all([
    expectRecoverableRecording(firstRecording.recordingDir),
    expectRecoverableRecording(secondRecording.recordingDir),
  ]);
});

async function prepareAnimatedPage(page: Page): Promise<void> {
  await page.setViewport({ width: 320, height: 240 });
  await page.setContent(`<!doctype html>
    <style>
      #box { width: 60px; height: 60px; background: blue; animation: move 0.2s linear infinite alternate; }
      @keyframes move { to { transform: translateX(200px); background: orange; } }
    </style>
    <div id="box"></div>`);
  await page.bringToFront();
}

async function waitForFrames(recordingDir: string, expected: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const files = await readdir(recordingDir);
    if (files.filter((name) => /^frame-\d+\.jpg$/.test(name)).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${expected} frames landed on disk`);
}

async function expectRecoverableRecording(recordingDir: string): Promise<void> {
  const files = await readdir(recordingDir);
  expect(files.some((name) => /^frame-\d+\.jpg$/.test(name))).toBe(true);
  expect((await readFile(join(recordingDir, 'frames.ndjson'), 'utf8')).trim()).not.toBe('');
  const manifest = JSON.parse(await readFile(join(recordingDir, 'recording.json'), 'utf8')) as {
    status: string;
  };
  expect(manifest.status).toBe('unassembled');
}

function pageTargetId(page: Page): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
