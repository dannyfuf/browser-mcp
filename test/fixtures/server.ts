import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const html = readFileSync(join(here, 'page.html'), 'utf8');

export interface FixtureServer {
  url: string;
  stop: () => void;
}

export function startFixtureServer(): FixtureServer {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname === '/other') {
        return new Response('<!doctype html><h1 id="other">Other page</h1>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
