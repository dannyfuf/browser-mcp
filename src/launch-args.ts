import type { LaunchOptions } from 'puppeteer';

export function computeLaunchOptions(env: Record<string, string | undefined>): LaunchOptions {
  const headless = env.BROWSER_HEADLESS === '1';
  const userDataDir = env.BROWSER_USER_DATA_DIR || undefined;

  return {
    headless,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
}
