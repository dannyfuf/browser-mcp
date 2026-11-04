import type { LaunchOptions } from 'puppeteer';
import { logger } from './logger.ts';

const CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'] as const;

export function computeLaunchOptions(env: Record<string, string | undefined>): LaunchOptions {
  const headless = env.BROWSER_HEADLESS === '1';
  const userDataDir = env.BROWSER_USER_DATA_DIR || undefined;
  const args = ['--no-first-run', '--no-default-browser-check'];
  const stealth = env.BROWSER_STEALTH !== '0';

  if (stealth) args.push('--disable-blink-features=AutomationControlled');

  if (env.BROWSER_NO_SANDBOX === '1') {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    );
  }

  const options: LaunchOptions = {
    headless,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir,
    args,
  };

  if (stealth) options.ignoreDefaultArgs = ['--enable-automation'];

  const channel = env.BROWSER_CHANNEL;
  if (channel && env.PUPPETEER_EXECUTABLE_PATH) {
    logger.info('ignoring BROWSER_CHANNEL because PUPPETEER_EXECUTABLE_PATH takes precedence');
  } else if (channel && isChannel(channel)) {
    options.channel = channel;
  } else if (channel) {
    logger.warn('ignoring invalid BROWSER_CHANNEL', { channel, allowed: CHANNELS });
  }

  return options;
}

function isChannel(value: string): value is (typeof CHANNELS)[number] {
  return CHANNELS.includes(value as (typeof CHANNELS)[number]);
}
