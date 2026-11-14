import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { refuse } from '../server/guard.ts';

const o = { port: 4880, token: 'a'.repeat(48) };

function req(headers: Record<string, string>, method = 'GET', url = '/api/agents'): IncomingMessage {
  return { headers: { host: '127.0.0.1:4880', 'x-agentyard-token': o.token, ...headers }, method, url } as unknown as IncomingMessage;
}

describe('guard', () => {
  it('lets this computer’s own page through', () => {
    expect(refuse(req({}), o)).toBeNull();
    expect(refuse(req({ host: 'localhost:4880', origin: 'http://localhost:4880', 'sec-fetch-site': 'same-origin' }), o)).toBeNull();
    expect(refuse(req({ 'content-type': 'application/json' }, 'POST'), o)).toBeNull();
  });

  it('refuses another host name (DNS rebinding)', () => {
    expect(refuse(req({ host: 'evil.example:4880' }), o)).toMatch(/Host/);
  });

  it('refuses other websites', () => {
    expect(refuse(req({ origin: 'https://evil.example' }), o)).toMatch(/Origin/);
    expect(refuse(req({ 'sec-fetch-site': 'cross-site' }), o)).toMatch(/Cross-site/);
  });

  it('refuses writes that are not JSON (they would skip the CORS preflight)', () => {
    expect(refuse(req({ 'content-type': 'text/plain' }, 'POST'), o)).toMatch(/JSON/);
  });

  it('refuses a missing or wrong token', () => {
    expect(refuse(req({ 'x-agentyard-token': '' }), o)).toMatch(/token/);
    expect(refuse(req({ 'x-agentyard-token': 'b'.repeat(48) }), o)).toMatch(/token/);
    expect(refuse({ ...req({}), headers: { host: '127.0.0.1:4880' }, url: `/api/events?token=${o.token}` } as unknown as IncomingMessage, o)).toBeNull();
  });
});
