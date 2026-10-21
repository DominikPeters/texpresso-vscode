import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

test('engine runner hides native windows by default and requires an explicit opt-in to show them', () => {
  const file = path.resolve(__dirname, '../../scripts/test-node.cjs');
  for (const optIn of [undefined, '0', '1']) {
    let childEnv: Record<string, string | undefined> | undefined;
    const env = { SDL_VIDEODRIVER: 'cocoa', TEXPRESSO_TEST_NATIVE_WINDOW: optIn, PATH: '/tex/bin' };
    runInNewContext(fs.readFileSync(file, 'utf8'), {
      __dirname: path.dirname(file),
      process: { argv: ['node', file, 'engine'], execPath: process.execPath, env },
      require: (name: string) => name === 'node:fs' ? { readdirSync: () => ['smoke.test.js'] } :
        name === 'node:path' ? path : { spawnSync: (_command: string, _args: string[], options: { env: typeof env }) => {
          childEnv = options.env; return { status: 0 };
        } }
    });
    assert.equal(childEnv!.SDL_VIDEODRIVER, optIn === '1' ? 'cocoa' : 'dummy');
    assert.equal(childEnv!.PATH, '/tex/bin');
    assert.equal(env.SDL_VIDEODRIVER, 'cocoa', 'parent environment stays intact');
  }
});
