import type { ZodRawShape, z } from 'zod';

// MCP content blocks. Mirrors the SDK's CallToolResult shape loosely.
export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image'; data: string; mimeType: string };
export type ToolContent = TextContent | ImageContent;

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputShape: S;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult> | ToolResult;
}

// Helper for building tool defs with proper inference.
export function tool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function textOk(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errResult(err: unknown): ToolResult {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: 'text', text }], isError: true };
}

import { diagnosticsTools } from './diagnostics.ts';
import { inspectionTools } from './inspection.ts';
import { interactionTools } from './interaction.ts';
// Registered tools — populated by the tool group modules below.
import { navigationTools } from './navigation.ts';
import { performanceTools } from './performance.ts';
import { recordingTools } from './recording.ts';
import { stateTools } from './state.ts';
import { tabsTools } from './tabs.ts';

const pingTool = tool({
  name: 'ping',
  description: 'Returns "pong". Use to verify the MCP server is reachable.',
  inputShape: {},
  handler: () => textOk('pong'),
});

export const tools: ToolDef<any>[] = [
  pingTool,
  ...navigationTools,
  ...interactionTools,
  ...inspectionTools,
  ...diagnosticsTools,
  ...stateTools,
  ...tabsTools,
  ...recordingTools,
  ...performanceTools,
];
