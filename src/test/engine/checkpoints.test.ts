import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const binary = process.env.TEXPRESSO_BINARY;
test('compiler fences reuse the expensive figure for later prose but rebuild changed loop geometry',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-checkpoints-')));
    try {
      // The shared harness checks each original/edited raster against an
      // independent clean engine. Token coverage avoids machine-speed assertions.
      await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../../../scripts/profiling/checkpoints.cjs'), root], {
        env: { ...process.env, TEXPRESSO_CHECKPOINT_PAGES: '2', TEXPRESSO_CHECKPOINT_SITES: 'loop,after', TEXPRESSO_CHECKPOINT_REPEATS: '1' },
        timeout: 85000, maxBuffer: 1024 * 1024
      });
      const data = JSON.parse(await fs.readFile(path.join(root, 'checkpoints.json'), 'utf8')) as {
        rows: { site: string; operations: { rollback: { tokens: number; resumeTokens: number }[] }[] }[];
      };
      assert.equal(data.rows.length, 2);
      for (const row of data.rows) {
        for (const operation of row.operations.slice(1)) {
          assert.equal(operation.rollback.length, 1);
          const rollback = operation.rollback[0];
          const replay = rollback.tokens - rollback.resumeTokens;
          assert.ok(rollback.resumeTokens > 0, 'warm edit resumes a retained compiler process');
          if (row.site === 'after') {
            assert.ok(replay < rollback.tokens / 10, 'prose after the figure retains its expensive expansion');
          } else {
            assert.ok(replay > rollback.tokens / 2, 'changed loop geometry rebuilds the expensive expansion');
          }
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
