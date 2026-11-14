// Every test file gets its own Agentyard state folder, so no test can touch a real ~/.agentyard.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTYARD_DATA_DIR = mkdtempSync(join(tmpdir(), 'agentyard-test-'));
process.env.AGENTYARD_HISTORY = '0';
