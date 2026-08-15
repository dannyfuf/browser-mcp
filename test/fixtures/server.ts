import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const html = readFileSync(join(here, 'page.html'), 'utf8');

export interface FixtureServer {
  url: string;
  stop: () => Promise<void>;
}

export function startFixtureServer(): FixtureServer {
  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
    },
    (req) => {
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
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    stop: () => server.shutdown(),
  };
}
