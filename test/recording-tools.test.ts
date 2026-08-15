import { readdir, rm, stat } from 'node:fs/promises';
import { expect } from '@std/expect';
import { describe, test } from '@std/testing/bdd';
import { z } from 'zod';
import { session } from '../src/browser.ts';
import { type ToolDef, tools } from '../src/tools/registry.ts';

function getTool(name: string): ToolDef<any> {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new Error(`tool ${name} not registered`);
  return definition;
}

describe('recording tools', () => {
  test('registers start and stop in the flat tool array', () => {
    expect(getTool('browser_start_recording').name).toBe('browser_start_recording');
    expect(getTool('browser_stop_recording').name).toBe('browser_stop_recording');
  });

  test('start schema accepts the documented inputs at their bounds', () => {
    const schema = z.object(getTool('browser_start_recording').inputShape);

    expect(
      schema.safeParse({
        tab: 1,
        max_duration_s: 300,
        quality: 100,
        max_width: 3840,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  test('start schema rejects values outside the recording caps', () => {
    const schema = z.object(getTool('browser_start_recording').inputShape);

    for (const args of [
      { max_duration_s: 301 },
      { max_duration_s: 0 },
      { quality: 0 },
      { quality: 101 },
      { max_width: 319 },
      { max_width: 3841 },
      { tab: 0 },
    ]) {
      expect(schema.safeParse(args).success).toBe(false);
    }
  });

  test('stop schema takes no arguments', () => {
    const schema = z.object(getTool('browser_stop_recording').inputShape).strict();

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ tab: 1 }).success).toBe(false);
  });

  test('start rejects an unknown requested tab before entering the recording engine', async () => {
    await expect(getTool('browser_start_recording').handler({ tab: 999_999 })).rejects.toThrow(
      'tab 999999 not found',
    );
  });

  test('start and stop complete a real recording round-trip', async () => {
    const artifactDir = await Deno.makeTempDir({ prefix: 'browser-mcp-tool-roundtrip-' });
    const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;
    const originalFfmpegPath = process.env.BROWSER_FFMPEG_PATH;
    process.env.BROWSER_ARTIFACT_DIR = artifactDir;
    process.env.BROWSER_FFMPEG_PATH = '/definitely/not-installed/browser-mcp-ffmpeg';

    try {
      const page = await session.getCurrentPage();
      await page.setContent(`<!doctype html>
        <style>
          #box { width: 50px; height: 50px; background: blue; animation: move 0.2s infinite alternate; }
          @keyframes move { to { transform: translateX(150px); } }
        </style>
        <div id="box"></div>`);
      const start = await getTool('browser_start_recording').handler({});
      const recordingDir = textBlocks(start)
        .find((line) => line.startsWith('Recording directory: '))
        ?.slice('Recording directory: '.length);
      expect(recordingDir).toBeDefined();

      await waitForFrame(recordingDir as string);
      const stop = await getTool('browser_stop_recording').handler({});
      const stopText = textBlocks(stop).join('\n');
      expect(stopText).toContain(`Frames directory: ${recordingDir}`);
      expect(stopText).toMatch(/Frame count: [1-9]\d*/);
      expect((await stat(recordingDir as string)).isDirectory()).toBe(true);
    } finally {
      await session.close();
      restoreEnvironment('BROWSER_ARTIFACT_DIR', originalArtifactDir);
      restoreEnvironment('BROWSER_FFMPEG_PATH', originalFfmpegPath);
      await rm(artifactDir, { force: true, recursive: true });
    }
  });
});

function textBlocks(result: Awaited<ReturnType<ToolDef<any>['handler']>>): string[] {
  return result.content.flatMap((content) => (content.type === 'text' ? [content.text] : []));
}

async function waitForFrame(recordingDir: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const files = await readdir(recordingDir);
    if (files.some((name) => /^frame-\d+\.jpg$/.test(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('recording tool did not persist a frame');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
