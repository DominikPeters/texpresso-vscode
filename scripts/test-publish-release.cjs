const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promote } = require('./publish-release.cjs');

function fixture({ draft = true, digest = 'a'.repeat(64), tagSHA = '1'.repeat(40) } = {}) {
  const events = [], sha = '1'.repeat(40);
  const release = { id: 1, tag_name: 'v2.0.0', target_commitish: sha, draft };
  const assets = [{ name: 'texpresso-2.0.0-sources-linux-x64.tar.gz', sha256: 'a'.repeat(64), bytes: 100 }];
  const github = { rest: { git: {
    getRef: async () => ({ data: { object: { type: 'commit', sha: tagSHA } } })
  }, repos: {
    listReleases: 'releases', listReleaseAssets: 'assets',
    updateRelease: async () => { events.push('publish'); return { data: { ...release, draft: false } }; }
  } }, paginate: async endpoint => endpoint === 'releases' ? [release] : [{ ...assets[0], size: 100, digest: 'sha256:' + digest }] };
  const operations = { upload: async () => events.push('upload'), publicCheck: async () => events.push('public'), hashAsset: async () => digest };
  return { github, repo: { owner: 'owner', repo: 'repo' }, candidate: { tag: 'v2.0.0', sha, assets }, operations, events };
}

test('source release becomes public only after exact asset verification', async () => {
  const f = fixture(); await promote(f.github, f.repo, f.candidate, f.operations);
  assert.deepEqual(f.events, ['upload', 'publish', 'public']);
});
test('published release retries reuse identical sources without overwriting or republishing', async () => {
  const f = fixture({ draft: false }); await promote(f.github, f.repo, f.candidate, f.operations);
  assert.deepEqual(f.events, ['public']);
});
test('a changed public asset or wrong tag commit blocks promotion', async () => {
  const f = fixture({ draft: false, digest: 'b'.repeat(64) });
  await assert.rejects(promote(f.github, f.repo, f.candidate, f.operations), /checksum/);
  assert.deepEqual(f.events, []);
  const wrong = fixture({ tagSHA: '2'.repeat(40) });
  await assert.rejects(promote(wrong.github, wrong.repo, wrong.candidate, wrong.operations), /reviewed commit/);
  assert.deepEqual(wrong.events, []);
});
test('unavailable public source downloads block the subsequent Marketplace step', async () => {
  const f = fixture(); f.operations.publicCheck = async () => { throw new Error('not public'); };
  await assert.rejects(promote(f.github, f.repo, f.candidate, f.operations), /not public/);
  assert.deepEqual(f.events, ['upload', 'publish']);
});
