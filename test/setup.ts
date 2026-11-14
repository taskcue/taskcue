// Every test file gets its own Taskcue state folder, so no test can touch a real ~/.taskcue.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKCUE_DATA_DIR = mkdtempSync(join(tmpdir(), 'taskcue-test-'));
process.env.TASKCUE_HISTORY = '0';
