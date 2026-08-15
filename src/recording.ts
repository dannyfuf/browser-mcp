import type { Page } from 'puppeteer';

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
}

const activeRecordings = new Map<string, ActiveRecording>();

export async function startRecording(
  page: Page,
  targetId: string,
  opts: RecordingOptions,
): Promise<ActiveRecording> {
  void page;
  void targetId;
  void opts;
  void activeRecordings;
  throw new Error('recording engine not implemented yet');
}

export async function stopRecording(targetId: string): Promise<StopResult> {
  void targetId;
  throw new Error('recording engine not implemented yet');
}

export async function finalizeRecording(targetId: string): Promise<StopResult | undefined> {
  void targetId;
  throw new Error('recording engine not implemented yet');
}

export async function finalizeAllRecordings(): Promise<StopResult[]> {
  throw new Error('recording engine not implemented yet');
}

export function isRecording(targetId: string): boolean {
  void targetId;
  throw new Error('recording engine not implemented yet');
}
