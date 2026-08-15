import { expect } from '@std/expect';
import { test } from '@std/testing/bdd';
import { computeLaunchOptions } from '../src/launch-args.ts';

const BASELINE_ARGS = ['--no-first-run', '--no-default-browser-check'];
const HARDENED_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

test('keeps baseline launch args when BROWSER_NO_SANDBOX is unset', () => {
  expect(computeLaunchOptions({}).args).toEqual(BASELINE_ARGS);
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
