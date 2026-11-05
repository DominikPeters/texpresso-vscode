const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyRelease, releaseAssets } = require('./verify-release.cjs');

async function promote(github, repo, candidate, operations) {
  const { tag, sha, assets } = candidate;
  try {
    let object = (await github.rest.git.getRef({ ...repo, ref: 'tags/' + tag })).data.object;
    for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
      object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object;
    }
    assert.equal(object.type, 'commit'); assert.equal(object.sha, sha, 'existing release tag must match the reviewed commit');
  } catch (error) { if (error.status !== 404) { throw error; } }
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  let release = releases.find(item => item.tag_name === tag);
  if (!release) {
    release = (await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: sha, name: 'TeXpresso ' + tag,
      draft: true, prerelease: false,
      body: 'TeXpresso live LaTeX preview. The extension code is MIT; bundled native components have additional licenses. '
        + 'Matching corresponding-source archives, build instructions and checksums are attached below. '
        + 'Complete third-party notices are included in each VSIX.' })).data;
  }
  if (release.draft) {
    assert.equal(release.target_commitish, sha, 'draft release must belong to the reviewed commit');
    await operations.upload();
  }
  // Published releases are immutable here. A retry after Marketplace failure
  // can reuse identical assets, but can never clobber a prior public release.
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  assert.deepEqual(uploaded.map(asset => asset.name).sort(), assets.map(asset => asset.name).sort(), 'release contains exactly the reviewed binary/source assets');
  for (const expected of assets) {
    const asset = uploaded.find(item => item.name === expected.name);
    assert.equal(asset.size, expected.bytes, 'release asset size: ' + expected.name);
    const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : await operations.hashAsset(asset);
    assert.equal(digest, expected.sha256, 'immutable release asset checksum: ' + expected.name);
  }
  if (release.draft) {
    release = (await github.rest.repos.updateRelease({ ...repo, release_id: release.id, draft: false })).data;
  }
  for (const asset of assets.filter(item => item.name.endsWith('.tar.gz'))) {
    await operations.publicCheck(`https://github.com/${repo.owner}/${repo.repo}/releases/download/${tag}/${asset.name}`);
  }
  return release;
}

async function publishRelease({ github, context, core }, directory = path.resolve('artifacts')) {
  verifyRelease(directory);
  const version = JSON.parse(fs.readFileSync('package.json')).version;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const assets = releaseAssets(directory);
  const tag = 'v' + version, repo = context.repo;
  const release = await promote(github, repo, { tag, sha, assets }, {
    upload: async () => execFileSync('gh', ['release', 'upload', tag, ...assets.map(asset => path.join(directory, asset.name)),
      '--repo', `${repo.owner}/${repo.repo}`, '--clobber'], { stdio: 'inherit' }),
    hashAsset: async asset => {
      const response = await fetch(asset.url, { headers: { Accept: 'application/octet-stream',
        Authorization: 'Bearer ' + process.env.GH_TOKEN, 'User-Agent': 'texpresso-release' } });
      assert.ok(response.ok, 'release asset download is available');
      const hash = crypto.createHash('sha256');
      for await (const chunk of response.body) { hash.update(chunk); }
      return hash.digest('hex');
    },
    publicCheck: async url => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
        if (response.ok) { return; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('Corresponding sources must be publicly downloadable before Marketplace publishing: ' + url);
    }
  });
  await core.summary.addHeading('Sources and binaries published').addLink(tag, release.html_url).write();
}
module.exports = { promote, publishRelease };
