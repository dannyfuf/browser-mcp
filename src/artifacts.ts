import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const DEFAULT_ARTIFACT_DIR_NAME = 'browser-mcp-artifacts';

export function resolveArtifactDir(): string {
  const configuredDir = process.env.BROWSER_ARTIFACT_DIR;
  return configuredDir ? resolve(configuredDir) : join(tmpdir(), DEFAULT_ARTIFACT_DIR_NAME);
}

export function artifactPath(prefix: string, ext: string): string {
  const artifactDir = resolveArtifactDir();
  mkdirSync(artifactDir, { recursive: true });
  return join(artifactDir, uniqueName(prefix, normalizeExtension(ext)));
}

export function artifactSubdir(name: string): string {
  const artifactDir = resolveArtifactDir();
  const subdir = join(artifactDir, uniqueName(name));
  mkdirSync(subdir, { recursive: true });
  return subdir;
}

function uniqueName(prefix: string, extension = ''): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${normalizeName(prefix)}-${timestamp}-${crypto.randomUUID()}${extension}`;
}

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
  return normalized || 'artifact';
}

function normalizeExtension(extension: string): string {
  if (!extension) return '';
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  if (extname(`artifact${normalized}`) !== normalized || !/^\.[a-zA-Z0-9]+$/.test(normalized)) {
    throw new Error(`invalid artifact extension: ${extension}`);
  }
  return normalized;
}
