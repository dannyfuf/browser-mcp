import { constants } from 'node:fs';
import { access, appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import type { CDPSession, Page, Protocol } from 'puppeteer';
import { artifactSubdir } from './artifacts.ts';

export interface RecordingOptions {
  maxDurationS?: number;
  quality?: number;
  maxWidth?: number;
}

export interface ActiveRecording {
  sessionId: string;
  recordingDir: string;
  frameCount: number;
  startedAtMonotonicMs: number;
  capFired: boolean;
}

export interface StopResult {
  framesDir: string;
  webmPath?: string;
  assembled: boolean;
  durationS: number;
  frameCount: number;
  byteSize: number;
  note?: string;
  capFired?: boolean;
}

export interface FinalizeOptions {
  assemble?: boolean;
}

type FrameEvent = Protocol.Page.ScreencastFrameEvent;

interface RecordingRuntime extends ActiveRecording {
  publicState: ActiveRecording;
  cdp: CDPSession;
  framesMetadataPath: string;
  frameListener: (event: FrameEvent) => void;
  metadataTail: Promise<void>;
  pendingWrites: Set<Promise<void>>;
  writeErrors: Error[];
  status: 'recording' | 'stopping' | 'stopped';
  timer?: ReturnType<typeof setTimeout>;
  stopPromise?: Promise<StopResult>;
  skipAssembly: boolean;
}

interface FrameMetadata {
  n: number;
  ts: number;
}

interface AssemblyResult {
  webmPath?: string;
  assembled: boolean;
  byteSize: number;
  note?: string;
}

const DEFAULT_MAX_DURATION_S = 120;
const MAX_DURATION_S = 300;
const DEFAULT_QUALITY = 50;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_EVERY_NTH_FRAME = 6;
const DEFAULT_FRAME_DURATION_S = 1 / 30;

const activeRecordings = new Map<string, RecordingRuntime>();

export async function startRecording(
  page: Page,
  targetId: string,
  opts: RecordingOptions,
): Promise<ActiveRecording> {
  const existing = activeRecordings.get(targetId);
  if (existing && existing.status !== 'stopped') {
    throw new Error(`tab ${targetId} already has an active recording`);
  }
  if (existing) activeRecordings.delete(targetId);

  const maxDurationS = normalizeMaxDuration(opts.maxDurationS);
  const quality = normalizeIntegerOption('quality', opts.quality, DEFAULT_QUALITY, 0, 100);
  const maxWidth = normalizeIntegerOption(
    'maxWidth',
    opts.maxWidth,
    DEFAULT_MAX_WIDTH,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const recordingDir = artifactSubdir('recording');
  const publicState: ActiveRecording = {
    sessionId: basename(recordingDir),
    recordingDir,
    frameCount: 0,
    startedAtMonotonicMs: performance.now(),
    capFired: false,
  };
  const cdp = await page.createCDPSession();
  const runtime: RecordingRuntime = {
    ...publicState,
    publicState,
    cdp,
    framesMetadataPath: join(recordingDir, 'frames.ndjson'),
    frameListener: () => undefined,
    metadataTail: Promise.resolve(),
    pendingWrites: new Set(),
    writeErrors: [],
    status: 'recording',
    skipAssembly: false,
  };
  runtime.frameListener = (event) => receiveFrame(runtime, event);

  activeRecordings.set(targetId, runtime);
  cdp.on('Page.screencastFrame', runtime.frameListener);

  try {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      everyNthFrame: DEFAULT_EVERY_NTH_FRAME,
    });
  } catch (error) {
    if (runtime.timer) clearTimeout(runtime.timer);
    cdp.off('Page.screencastFrame', runtime.frameListener);
    activeRecordings.delete(targetId);
    await cdp.detach().catch(() => undefined);
    throw error;
  }
  runtime.timer = setTimeout(() => {
    void beginStop(runtime, true, true).catch(() => undefined);
  }, maxDurationS * 1_000);

  return publicState;
}

export async function stopRecording(targetId: string): Promise<StopResult> {
  const runtime = activeRecordings.get(targetId);
  if (!runtime) throw new Error(`tab ${targetId} has no recording`);

  try {
    return await beginStop(runtime, false, true);
  } finally {
    if (runtime.status === 'stopped') activeRecordings.delete(targetId);
  }
}

export async function finalizeRecording(
  targetId: string,
  options: FinalizeOptions = {},
): Promise<StopResult | undefined> {
  const runtime = activeRecordings.get(targetId);
  if (!runtime) return undefined;

  try {
    return await beginStop(runtime, false, options.assemble !== false);
  } finally {
    if (runtime.status === 'stopped') activeRecordings.delete(targetId);
  }
}

export async function finalizeAllRecordings(options: FinalizeOptions = {}): Promise<StopResult[]> {
  const entries = [...activeRecordings.entries()];
  const results = await Promise.all(
    entries.map(async ([targetId]) => await finalizeRecording(targetId, options)),
  );
  return results.filter((result): result is StopResult => result !== undefined);
}

export function isRecording(targetId: string): boolean {
  const runtime = activeRecordings.get(targetId);
  return runtime?.status === 'recording' || runtime?.status === 'stopping';
}

function receiveFrame(runtime: RecordingRuntime, event: FrameEvent): void {
  void runtime.cdp
    .send('Page.screencastFrameAck', { sessionId: event.sessionId })
    .catch(() => undefined);
  if (runtime.status === 'stopped') return;

  const n = ++runtime.frameCount;
  runtime.publicState.frameCount = n;
  const ts = performance.now();
  const framePath = join(runtime.recordingDir, `frame-${n}.jpg`);
  const metadata = `${JSON.stringify({ n, ts } satisfies FrameMetadata)}\n`;
  const write = Promise.all([
    runtime.metadataTail,
    writeFile(framePath, event.data, { encoding: 'base64' }),
  ])
    .then(async () => await appendFile(runtime.framesMetadataPath, metadata, 'utf8'))
    .catch((error: unknown) => {
      runtime.writeErrors.push(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(() => runtime.pendingWrites.delete(write));
  runtime.metadataTail = write;
  runtime.pendingWrites.add(write);
}

function beginStop(
  runtime: RecordingRuntime,
  capFired: boolean,
  assemble: boolean,
): Promise<StopResult> {
  if (capFired) {
    runtime.capFired = true;
    runtime.publicState.capFired = true;
  }
  if (!assemble) runtime.skipAssembly = true;
  runtime.stopPromise ??= performStop(runtime);
  return runtime.stopPromise;
}

async function performStop(runtime: RecordingRuntime): Promise<StopResult> {
  runtime.status = 'stopping';
  if (runtime.timer) clearTimeout(runtime.timer);

  let stopWarning: string | undefined;
  try {
    await runtime.cdp.send('Page.stopScreencast');
  } catch (error) {
    stopWarning = `screencast stop warning: ${errorMessage(error)}`;
  } finally {
    runtime.cdp.off('Page.screencastFrame', runtime.frameListener);
  }

  while (runtime.pendingWrites.size > 0) {
    await Promise.all([...runtime.pendingWrites]);
  }
  await runtime.cdp.detach().catch(() => undefined);
  runtime.status = 'stopped';

  if (runtime.writeErrors.length > 0) {
    throw new Error('failed to persist one or more screencast frames', {
      cause: runtime.writeErrors[0],
    });
  }

  const assembly = runtime.skipAssembly
    ? {
        assembled: false,
        byteSize: 0,
        note: 'assembly skipped during shutdown; frames retained as unassembled',
      }
    : await assembleWebm(runtime);
  const notes = [
    runtime.capFired ? 'maximum duration cap fired' : undefined,
    stopWarning,
    assembly.note,
  ].filter((note): note is string => note !== undefined);

  const result: StopResult = {
    framesDir: runtime.recordingDir,
    webmPath: assembly.webmPath,
    assembled: assembly.assembled,
    durationS: Math.max(0, (performance.now() - runtime.startedAtMonotonicMs) / 1_000),
    frameCount: runtime.frameCount,
    byteSize: assembly.byteSize,
    note: notes.length > 0 ? notes.join('; ') : undefined,
    capFired: runtime.capFired,
  };
  await writeFile(
    join(runtime.recordingDir, 'recording.json'),
    `${JSON.stringify(
      {
        sessionId: runtime.sessionId,
        status: result.assembled ? 'assembled' : 'unassembled',
        finalizedAt: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return result;
}

async function assembleWebm(runtime: RecordingRuntime): Promise<AssemblyResult> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    return { assembled: false, byteSize: 0, note: 'assembly skipped: ffmpeg not found' };
  }

  const frames = await readFrameMetadata(runtime.framesMetadataPath);
  if (frames.length === 0) {
    return { assembled: false, byteSize: 0, note: 'assembly skipped: no frames captured' };
  }

  const concatPath = join(runtime.recordingDir, 'frames.concat.txt');
  const webmPath = join(runtime.recordingDir, `${runtime.sessionId}.webm`);
  await writeFile(concatPath, concatManifest(runtime.recordingDir, frames), 'utf8');

  const vp9 = await runFfmpeg(ffmpegPath, concatPath, webmPath, 'libvpx-vp9');
  const vp8 = vp9.success ? undefined : await runFfmpeg(ffmpegPath, concatPath, webmPath, 'libvpx');
  const assembled = vp9.success || vp8?.success === true;

  if (!assembled) {
    await rm(webmPath, { force: true });
    await rm(concatPath, { force: true });
    const detail = vp8?.stderr || vp9.stderr;
    return {
      assembled: false,
      byteSize: 0,
      note: `assembly failed; frames retained${detail ? `: ${detail}` : ''}`,
    };
  }

  const outputStat = await stat(webmPath);
  await Promise.all(
    frames.map(async ({ n }) => await rm(join(runtime.recordingDir, `frame-${n}.jpg`))),
  );
  await rm(concatPath, { force: true });
  return { assembled: true, byteSize: outputStat.size, webmPath };
}

async function resolveFfmpegPath(): Promise<string | undefined> {
  const configured = process.env.BROWSER_FFMPEG_PATH?.trim();
  if (configured) return (await isExecutable(configured)) ? configured : undefined;

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'ffmpeg');
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFrameMetadata(path: string): Promise<FrameMetadata[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FrameMetadata)
    .sort((left, right) => left.n - right.n);
}

function concatManifest(recordingDir: string, frames: FrameMetadata[]): string {
  const durations = frames.map((frame, index) => {
    const next = frames[index + 1];
    if (next) return Math.max(0.001, (next.ts - frame.ts) / 1_000);
    return index > 0
      ? Math.max(0.001, (frame.ts - frames[index - 1].ts) / 1_000)
      : DEFAULT_FRAME_DURATION_S;
  });
  const lines = frames.flatMap(({ n }, index) => [
    `file '${escapeConcatPath(join(recordingDir, `frame-${n}.jpg`))}'`,
    `duration ${durations[index].toFixed(6)}`,
  ]);
  const lastFrame = frames.at(-1);
  if (lastFrame) {
    lines.push(`file '${escapeConcatPath(join(recordingDir, `frame-${lastFrame.n}.jpg`))}'`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeConcatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

async function runFfmpeg(
  ffmpegPath: string,
  concatPath: string,
  webmPath: string,
  codec: 'libvpx-vp9' | 'libvpx',
): Promise<{ success: boolean; stderr: string }> {
  const command = new Deno.Command(ffmpegPath, {
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-an',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-fps_mode',
      'vfr',
      '-c:v',
      codec,
      '-pix_fmt',
      'yuv420p',
      webmPath,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });

  try {
    const output = await command.output();
    return {
      success: output.success,
      stderr: new TextDecoder().decode(output.stderr).trim().slice(0, 500),
    };
  } catch (error) {
    return { success: false, stderr: errorMessage(error) };
  }
}

function normalizeMaxDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_MAX_DURATION_S;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('maxDurationS must be a positive finite number');
  }
  return Math.min(duration, MAX_DURATION_S);
}

function normalizeIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
