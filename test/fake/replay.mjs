#!/usr/bin/env node
// A stand-in for an agent's binary in tests: plays back a conversation captured from the real one
// (test/fixtures/*.jsonl). Each line the real binary wrote is written again; where the client wrote a
// line, it waits for the client to write one. REPLAY_FIXTURE names the capture.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const entries = readFileSync(process.env.REPLAY_FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const input = createInterface({ input: process.stdin });
const waiting = [];
const received = [];
input.on('line', (l) => (waiting.length ? waiting.shift()(l) : received.push(l)));
const nextLine = () => new Promise((resolve) => (received.length ? resolve(received.shift()) : waiting.push(resolve)));

for (const e of entries) {
  if (e.dir === 'in') await nextLine();
  else process.stdout.write(JSON.stringify(e.msg) + '\n');
}
// Stay open like the real binary until the client closes it.
process.stdin.resume();
