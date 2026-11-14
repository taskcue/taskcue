import { describe, expect, it } from 'vitest';
import { childEnv } from '../server/agents/process.ts';

describe('childEnv', () => {
  it('removes Taskcue’s own settings and a parent session’s identity', () => {
    const env = childEnv({ PATH: '/bin', TASKCUE_PORT: '4880', TASKCUE_DATA_DIR: '/x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', NODE_ENV: 'production' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('keeps other programs’ TASKCUE_* variables, which a session working on them needs', () => {
    expect(childEnv({ TASKCUE_BUILD_ID: 'b1', TASKCUE_DRAINER_ENABLED: '1' })).toEqual({ TASKCUE_BUILD_ID: 'b1', TASKCUE_DRAINER_ENABLED: '1' });
  });
});
