// Who may call the API. Taskcue drives agents that edit files and run commands, so its API is
// treated like a shell: only this computer's own browser tab, holding the token, may use it.
//
//   - The server listens on 127.0.0.1 only.
//   - Host must be localhost or 127.0.0.1 on our port (stops DNS rebinding).
//   - Origin, when sent, must be this server (stops other websites).
//   - Sec-Fetch-Site, when sent, must be same-origin or none (stops <img>/<form> requests from other sites).
//   - Writes must be JSON (forces a CORS preflight no other site can pass).
//   - Every /api call carries the token from ~/.taskcue-canvas/token (stops other programs and users on this computer).

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface GuardOptions {
  port: number;
  token: string;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Why a request is refused, or null when it may go ahead. */
export function refuse(req: IncomingMessage, o: GuardOptions): string | null {
  const host = String(req.headers.host ?? '');
  const allowedHosts = [`127.0.0.1:${o.port}`, `localhost:${o.port}`];
  if (!allowedHosts.includes(host)) return 'Host not allowed';

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((h) => origin === `http://${h}`)) return 'Origin not allowed';

  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Cross-site request';

  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/json')) return 'Writes must be JSON';
  }

  const url = new URL(req.url ?? '/', `http://${host}`);
  const given = String(req.headers['x-taskcue-token'] ?? url.searchParams.get('token') ?? '');
  if (!given || !sameToken(given, o.token)) return 'Missing or wrong token';
  return null;
}
