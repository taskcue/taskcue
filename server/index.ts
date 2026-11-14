// TaskCue's server: the API, the event stream, and the page. No framework; Node's own http.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalDecision, PermissionMode, ServerEvent, StartRequest } from '../shared/types.ts';
import { adapters, shutdownAgents } from './agents/index.ts';
import { apiToken, dataDir, port } from './config.ts';
import { refuse } from './guard.ts';
import { addProject, addedProjects, listProjects, normalizeFolder, removeProject } from './projects.ts';
import { Sessions } from './sessions.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const production = process.env.NODE_ENV === 'production';
const token = apiToken();
const sessions = new Sessions();

const PERMISSIONS: PermissionMode[] = ['ask', 'auto-edit', 'full'];
const DECISIONS: ApprovalDecision[] = ['allow', 'allow-session', 'deny'];

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'Too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

function text(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  return v;
}

function projects() {
  return listProjects(sessions.list());
}

// ── The event stream ────────────────────────────────────────────────────────────────────────
const streams = new Set<ServerResponse>();

function broadcast(ev: ServerEvent): void {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of streams) res.write(line);
}

let projectsKey = '';
sessions.on('event', (ev: ServerEvent) => {
  broadcast(ev);
  if (ev.type === 'session' || ev.type === 'session-removed') {
    const p = projects();
    const key = JSON.stringify(p);
    if (key !== projectsKey) {
      projectsKey = key;
      broadcast({ type: 'projects', projects: p });
    }
  }
});

function openStream(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const hello: ServerEvent = { type: 'hello', sessions: sessions.list(), projects: projects(), approvals: sessions.pendingApprovals() };
  res.write(`data: ${JSON.stringify(hello)}\n\n`);
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
  });
}

// ── The API ─────────────────────────────────────────────────────────────────────────────────
async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/api/events') return openStream(res);

  if (method === 'GET' && path === '/api/agents') {
    return json(res, 200, await Promise.all(Object.values(adapters).map((a) => a.detect())));
  }

  if (method === 'POST' && path === '/api/projects') {
    const b = await body(req);
    const added = addProject(text(b.path, 'path'));
    void sessions.refreshExternal(addedProjects());
    broadcast({ type: 'projects', projects: projects() });
    return json(res, 200, { path: added });
  }

  if (method === 'POST' && path === '/api/projects/remove') {
    const b = await body(req);
    removeProject(text(b.path, 'path'));
    broadcast({ type: 'projects', projects: projects() });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && path === '/api/sessions') {
    const b = await body(req);
    const agent = text(b.agent, 'agent');
    if (!(agent in adapters)) throw new HttpError(400, `Unknown agent: ${agent}`);
    const permission = PERMISSIONS.includes(b.permission) ? (b.permission as PermissionMode) : 'ask';
    const start: StartRequest = {
      agent: agent as StartRequest['agent'],
      cwd: normalizeFolder(text(b.cwd, 'cwd')),
      text: text(b.text, 'text'),
      model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null,
      permission,
    };
    try {
      return json(res, 200, await sessions.start(start));
    } catch (err) {
      throw new HttpError(500, (err as Error).message);
    }
  }

  if (method === 'GET' && (m = path.match(/^\/api\/sessions\/([^/]+)\/items$/))) {
    const id = decodeURIComponent(m[1]);
    if (!sessions.get(id)) throw new HttpError(404, 'No such session');
    return json(res, 200, await sessions.conversation(id));
  }

  if (method === 'POST' && (m = path.match(/^\/api\/sessions\/([^/]+)\/(send|interrupt|stop|hide)$/))) {
    const id = decodeURIComponent(m[1]);
    if (!sessions.get(id)) throw new HttpError(404, 'No such session');
    const b = await body(req);
    if (m[2] === 'send') {
      const permission = PERMISSIONS.includes(b.permission) ? (b.permission as PermissionMode) : undefined;
      await sessions.send(id, text(b.text, 'text'), permission);
    } else if (m[2] === 'interrupt') await sessions.interrupt(id);
    else if (m[2] === 'stop') sessions.stop(id);
    else sessions.hide(id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && (m = path.match(/^\/api\/approvals\/([^/]+)\/([^/]+)$/))) {
    const b = await body(req);
    if (!DECISIONS.includes(b.decision)) throw new HttpError(400, 'decision must be allow, allow-session or deny');
    sessions.answer(decodeURIComponent(m[1]), decodeURIComponent(m[2]), b.decision);
    return json(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ── The page ────────────────────────────────────────────────────────────────────────────────
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const dist = join(root, 'dist');
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (file !== dist && !file.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('The page is not built. Run `pnpm build`, or `pnpm dev`.');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

async function main(): Promise<void> {
  let vite: import('vite').ViteDevServer | null = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const why = refuse(req, { port, token });
      if (why) return json(res, 403, { error: why });
      api(req, res, url).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) json(res, status, { error: (err as Error).message });
      });
      return;
    }
    // The page holds no data; it gets the token from the address the server prints.
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'Host not allowed' });
    if (vite) vite.middlewares(req, res, () => res.writeHead(404).end());
    else serveStatic(req, res, url);
  });

  if (!production) {
    // Hot reload rides on this same server, so development opens no second port.
    const { createServer: createVite } = await import('vite');
    vite = await createVite({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  }

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  TaskCue is running.\n\n  Open: http://127.0.0.1:${port}/#token=${token}\n\n  State: ${dataDir}\n`);
  });

  void sessions.refreshExternal(addedProjects());
  const refresh = setInterval(() => void sessions.refreshExternal(addedProjects()), 30_000);

  const shutdown = () => {
    clearInterval(refresh);
    sessions.stopAll();
    shutdownAgents();
    void vite?.close();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
