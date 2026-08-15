import { z } from 'zod';
import { session } from '../browser.ts';
import {
  type ActiveRecording,
  type StopResult,
  startRecording,
  stopRecording,
} from '../recording.ts';
import { type ToolDef, type ToolResult, tool } from './registry.ts';

const startRecordingTool = tool({
  name: 'browser_start_recording',
  description:
    'Start recording the current tab, or select a tab by id first. Returns the recording session id and artifact directory as text.',
  inputShape: {
    tab: z.number().int().positive().optional(),
    max_duration_s: z.number().int().positive().max(300).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    max_width: z.number().int().min(320).max(3840).optional(),
  },
  handler: async ({ tab, max_duration_s, quality, max_width }): Promise<ToolResult> => {
    if (tab !== undefined) {
      await session.switchTab(tab);
    }

    const page = await session.getCurrentPage();
    const recording = await startRecording(page, pageTargetId(page), {
      maxDurationS: max_duration_s,
      quality,
      maxWidth: max_width,
    });

    return startResult(recording);
  },
});

const stopRecordingTool = tool({
  name: 'browser_stop_recording',
  description:
    'Stop recording the current tab. Returns the webm path, or retained frames directory, plus duration, frame count, and byte size as text.',
  inputShape: {},
  handler: async (): Promise<ToolResult> => {
    const page = await session.getCurrentPage();
    const result = await stopRecording(pageTargetId(page));
    return stopResult(result);
  },
});

function pageTargetId(page: Awaited<ReturnType<typeof session.getCurrentPage>>): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

function startResult(recording: ActiveRecording): ToolResult {
  return {
    content: [
      { type: 'text', text: `Session ID: ${recording.sessionId}` },
      { type: 'text', text: `Recording directory: ${recording.recordingDir}` },
    ],
  };
}

function stopResult(result: StopResult): ToolResult {
  const artifact = result.webmPath ?? result.framesDir;
  const artifactLabel = result.webmPath ? 'WebM path' : 'Frames directory';
  const content: ToolResult['content'] = [
    { type: 'text', text: `${artifactLabel}: ${artifact}` },
    { type: 'text', text: `Duration: ${result.durationS} seconds` },
    { type: 'text', text: `Frame count: ${result.frameCount}` },
    { type: 'text', text: `Byte size: ${result.byteSize}` },
  ];

  if (result.note) {
    content.push({ type: 'text', text: `Note: ${result.note}` });
  }

  return { content };
}

export const recordingTools: ToolDef<any>[] = [startRecordingTool, stopRecordingTool];
