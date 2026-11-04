import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { computeLaunchOptions } from '../src/launch-args.ts';

const BASELINE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
];
const HARDENED_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

test('keeps baseline launch args when BROWSER_NO_SANDBOX is unset', () => {
  expect(computeLaunchOptions({}).args).toEqual(BASELINE_ARGS);
  expect(computeLaunchOptions({}).ignoreDefaultArgs).toEqual(['--enable-automation']);
});

test('appends hardened launch args when BROWSER_NO_SANDBOX is exactly 1', () => {
  expect(computeLaunchOptions({ BROWSER_NO_SANDBOX: '1' }).args).toEqual([
    ...BASELINE_ARGS,
    ...HARDENED_ARGS,
  ]);
});

test('does not enable hardened launch args for another truthy value', () => {
  expect(computeLaunchOptions({ BROWSER_NO_SANDBOX: 'true' }).args).toEqual(BASELINE_ARGS);
});

test('BROWSER_STEALTH=0 restores Puppeteer automation defaults', () => {
  const options = computeLaunchOptions({ BROWSER_STEALTH: '0' });
  expect(options.args).toEqual(['--no-first-run', '--no-default-browser-check']);
  expect(options.ignoreDefaultArgs).toBeUndefined();
});

test('accepts supported Chrome channels', () => {
  for (const channel of ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'] as const) {
    expect(computeLaunchOptions({ BROWSER_CHANNEL: channel }).channel).toBe(channel);
  }
});

test('ignores invalid Chrome channels', () => {
  expect(computeLaunchOptions({ BROWSER_CHANNEL: 'chromium' }).channel).toBeUndefined();
});

test('PUPPETEER_EXECUTABLE_PATH takes precedence over BROWSER_CHANNEL', () => {
  expect(
    computeLaunchOptions({
      BROWSER_CHANNEL: 'chrome',
      PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    }).channel,
  ).toBeUndefined();
});

test('combines stealth and no-sandbox arguments', () => {
  expect(computeLaunchOptions({ BROWSER_NO_SANDBOX: '1' })).toMatchObject({
    args: [...BASELINE_ARGS, ...HARDENED_ARGS],
    ignoreDefaultArgs: ['--enable-automation'],
  });
});
