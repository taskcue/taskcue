// Every test file gets its own TaskCue state folder, so no test can touch a real ~/.taskcue-canvas.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKCUE_CANVAS_DATA_DIR = mkdtempSync(join(tmpdir(), 'taskcue-canvas-test-'));
process.env.TASKCUE_CANVAS_HISTORY = '0';
