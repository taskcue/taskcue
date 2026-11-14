// Projects are folders. The board shows the folders the person added, plus every folder the
// agents worked in recently, newest activity first.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { Project, SessionSummary } from '../shared/types.ts';
import { readJson, writeJson } from './config.ts';

interface Settings {
  projects: string[];
}

const FILE = 'settings.json';

function settings(): Settings {
  const s = readJson<Settings>(FILE, { projects: [] });
  return { projects: Array.isArray(s.projects) ? s.projects : [] };
}

/** `~/code/app` → an absolute path; refuses what isn't a folder. */
export function normalizeFolder(input: string): string {
  const raw = input.trim().replace(/^~(?=$|\/)/, homedir());
  const path = resolve(raw);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
  return path;
}

export function addedProjects(): string[] {
  return settings().projects;
}

export function addProject(input: string): string {
  const path = normalizeFolder(input);
  const s = settings();
  if (!s.projects.includes(path)) writeJson(FILE, { ...s, projects: [path, ...s.projects] });
  return path;
}

export function removeProject(path: string): void {
  const s = settings();
  writeJson(FILE, { ...s, projects: s.projects.filter((p) => p !== path) });
}

export function listProjects(sessions: SessionSummary[]): Project[] {
  const latest = new Map<string, number>();
  for (const p of settings().projects) latest.set(p, 0);
  for (const s of sessions) latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.updatedAt));
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => ({ path, name: basename(path) || path, exists: existsSync(path) }));
}
