import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@std/expect';
import { afterAll, afterEach, beforeAll, beforeEach, test } from '@std/testing/bdd';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { finalizeRecording, isRecording, startRecording, stopRecording } from '../src/recording.ts';

const installedFfmpegPath = '/opt/homebrew/bin/ffmpeg';
const missingFfmpegPath = '/definitely/not-installed/browser-mcp-ffmpeg';
const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;
const originalFfmpegPath = process.env.BROWSER_FFMPEG_PATH;

let browser: Browser;
let page: Page;
let artifactDir: string;
let targetId: string;

beforeAll(async () => {
  browser = await puppeteer.launch({ headless: true });
});

beforeEach(async () => {
  artifactDir = await Deno.makeTempDir({ prefix: 'browser-mcp-recording-' });
  process.env.BROWSER_ARTIFACT_DIR = artifactDir;
  process.env.BROWSER_FFMPEG_PATH = missingFfmpegPath;
  targetId = crypto.randomUUID();
  page = await browser.newPage();
  await page.setViewport({ width: 320, height: 240 });
  await page.setContent(animatedFixture());
  await page.bringToFront();
});

afterEach(async () => {
  await finalizeRecording(targetId).catch(() => undefined);
  await page.close().catch(() => undefined);
  await rm(artifactDir, { force: true, recursive: true });
});

afterAll(async () => {
  await browser.close();
  restoreEnvironment('BROWSER_ARTIFACT_DIR', originalArtifactDir);
  restoreEnvironment('BROWSER_FFMPEG_PATH', originalFfmpegPath);
});

test('records frames and monotonic metadata through the start-stop lifecycle', async () => {
  const recording = await startRecording(page, targetId, {});
  expect(recording.recordingDir.startsWith(artifactDir)).toBe(true);
  expect(isRecording(targetId)).toBe(true);

  await waitForFrameCount(recording.recordingDir, 3);
  const metadata = await readMetadata(recording.recordingDir);
  expect(metadata.length).toBeGreaterThanOrEqual(3);
  for (let index = 1; index < metadata.length; index++) {
    expect(metadata[index].n).toBeGreaterThan(metadata[index - 1].n);
    expect(metadata[index].ts).toBeGreaterThanOrEqual(metadata[index - 1].ts);
  }

  const result = await stopRecording(targetId);
  expect(result.frameCount).toBeGreaterThanOrEqual(3);
  expect(result.durationS).toBeGreaterThan(0);
  expect(result.framesDir).toBe(recording.recordingDir);
  expect(isRecording(targetId)).toBe(false);
});

test('rejects a second active recording for the same tab', async () => {
  await startRecording(page, targetId, {});

  await expect(startRecording(page, targetId, {})).rejects.toThrow(
    'already has an active recording',
  );
});

test('auto-stops at a short duration cap and reports that the cap fired', async () => {
  await startRecording(page, targetId, { maxDurationS: 0.2 });

  await waitFor(() => !isRecording(targetId), 'recording did not auto-stop');
  const result = await stopRecording(targetId);
  expect(result.capFired).toBe(true);
  expect(result.note).toContain('maximum duration cap fired');
  expect(result.durationS).toBeGreaterThanOrEqual(0.15);
});

test('lands frame bytes on disk as screencast events arrive', async () => {
  const recording = await startRecording(page, targetId, {});

  await waitForFrameCount(recording.recordingDir, 2);
  const frameNames = await jpegFrameNames(recording.recordingDir);
  expect(frameNames.length).toBeGreaterThanOrEqual(2);
  for (const frameName of frameNames) {
    expect((await stat(join(recording.recordingDir, frameName))).size).toBeGreaterThan(0);
  }
  expect(Object.keys(recording).sort()).toEqual([
    'capFired',
    'frameCount',
    'recordingDir',
    'sessionId',
    'startedAtMonotonicMs',
  ]);
});

test('assembles a non-empty webm with ffmpeg and deletes the jpeg frames', async () => {
  process.env.BROWSER_FFMPEG_PATH = installedFfmpegPath;
  const recording = await startRecording(page, targetId, {});
  await waitForFrameCount(recording.recordingDir, 4);

  const result = await stopRecording(targetId);
  expect(result.assembled).toBe(true);
  expect(result.webmPath).toBeDefined();
  expect(result.byteSize).toBeGreaterThan(0);
  expect((await stat(result.webmPath as string)).size).toBe(result.byteSize);
  expect(await jpegFrameNames(recording.recordingDir)).toEqual([]);
});

test('keeps frames and returns an assembly-skipped note when ffmpeg is absent', async () => {
  process.env.BROWSER_FFMPEG_PATH = missingFfmpegPath;
  const recording = await startRecording(page, targetId, {});
  await waitForFrameCount(recording.recordingDir, 2);

  const result = await stopRecording(targetId);
  expect(result.assembled).toBe(false);
  expect(result.webmPath).toBeUndefined();
  expect(result.byteSize).toBe(0);
  expect(result.note).toContain('assembly skipped');
  expect((await jpegFrameNames(recording.recordingDir)).length).toBeGreaterThanOrEqual(2);
});

function animatedFixture(): string {
  return `<!doctype html>
    <style>
      body { margin: 0; background: white; }
      #box { width: 80px; height: 80px; background: rgb(0, 80, 180); }
    </style>
    <div id="box"></div>
    <script>
      let frame = 0;
      const box = document.getElementById('box');
      setInterval(() => {
        frame += 1;
        box.style.transform = 'translateX(' + (frame % 200) + 'px)';
        box.style.background = 'rgb(' + (frame % 255) + ', 80, 180)';
      }, 16);
    </script>`;
}

async function waitForFrameCount(recordingDir: string, expected: number): Promise<void> {
  await waitFor(async () => {
    const frames = await jpegFrameNames(recordingDir);
    const metadata = await readMetadata(recordingDir);
    return frames.length >= expected && metadata.length >= expected;
  }, `fewer than ${expected} frames landed on disk`);
}

async function jpegFrameNames(recordingDir: string): Promise<string[]> {
  return (await readdir(recordingDir)).filter((name) => /^frame-\d+\.jpg$/.test(name));
}

async function readMetadata(recordingDir: string): Promise<Array<{ n: number; ts: number }>> {
  try {
    return (await readFile(join(recordingDir, 'frames.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { n: number; ts: number });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  failureMessage: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failureMessage);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
