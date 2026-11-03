const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const scopes = ['native/.work', 'native/.bundles', 'artifacts'];
const canonicalBundle = /^(?:darwin|linux|win32)-(?:arm64|x64|x86_64|aarch64|ia32)(?:-preview)?$/;
const experimentalFile = /\.(?:c|h|cpp|py|sh|js|cjs|ts|png|jpe?g|webp|svg)$/i;
const gib = bytes => (bytes / 2 ** 30).toFixed(2) + ' GiB';

function inspect(filename) {
  const stat = fs.lstatSync(filename);
  const state = { bytes: stat.isFile() ? stat.size : 0, newest: stat.mtimeMs, pinned: stat.isSymbolicLink() };
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(filename)) {
      const child = inspect(path.join(filename, name));
      state.bytes += child.bytes;
      state.newest = Math.max(state.newest, child.newest);
      state.pinned ||= name === '.keep' || child.pinned;
    }
  }
  return state;
}

function planCleanup(root, days = 7, now = Date.now()) {
  if (!Number.isFinite(days) || days < 0) { throw new Error('--days must be a nonnegative number'); }
  root = fs.realpathSync(root);
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  // Windows can report a short-name or differently cased spelling of the
  // same directory. Compare filesystem identities rather than path strings.
  const rootStat = fs.statSync(root, { bigint: true }), topStat = fs.statSync(top, { bigint: true });
  if (rootStat.dev !== topStat.dev || rootStat.ino !== topStat.ino) {
    throw new Error('Cleanup must run at the repository root: requested ' + root + ', Git root ' + top);
  }
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ...scopes], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const candidates = [], retained = [];
  for (const scope of scopes) {
    const directory = path.join(root, scope);
    if (!fs.existsSync(directory)) { continue; }
    if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Refusing symlinked output root: ' + scope); }
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', scope], { cwd: root });
    const names = fs.readdirSync(directory);
    const scopePinned = names.includes('.keep');
    const latest = new Map();
    if (scope === 'artifacts') {
      for (const name of names.filter(name => name.endsWith('.vsix'))) {
        const target = name.match(/-((?:darwin|linux|win32|alpine)-(?:x64|arm64|ia32|armhf))\.vsix$/)?.[1] || 'universal';
        const previous = latest.get(target);
        if (!previous || fs.lstatSync(path.join(directory, name)).mtimeMs > fs.lstatSync(path.join(directory, previous)).mtimeMs) {
          latest.set(target, name);
        }
      }
    }
    const packages = new Set([...latest.values()].flatMap(name => [name, name + '.sha256']));
    for (const name of names) {
      const relative = scope + '/' + name, filename = path.join(directory, name);
      const state = inspect(filename);
      const reason = tracked.some(file => file === relative || file.startsWith(relative + '/')) ? 'tracked content'
        : scopePinned || state.pinned || name.endsWith('.keep') || fs.existsSync(filename + '.keep') ? 'pinned or symlinked content'
        : scope === 'native/.bundles' && canonicalBundle.test(name) ? 'canonical local bundle'
        : scope === 'artifacts' && (packages.has(name) || experimentalFile.test(name)) ? 'latest package or experimental source/image'
        : state.newest >= now - days * 86400000 ? 'recent output' : undefined;
      const entry = { path: relative, bytes: state.bytes, newest: state.newest };
      if (reason) { retained.push({ ...entry, reason }); }
      else { candidates.push(entry); }
    }
  }
  return { root, candidates, retained };
}

function applyCleanup(plan) {
  // Recheck eligibility immediately before deletion, including tracked files,
  // new pins and recently written descendants. Never follow output symlinks.
  const eligible = new Map(planCleanup(plan.root, 0).candidates.map(entry => [entry.path, entry]));
  for (const entry of plan.candidates) {
    const current = eligible.get(entry.path);
    if (!current || current.newest > entry.newest || current.bytes !== entry.bytes) {
      throw new Error('Output became protected or changed: ' + entry.path);
    }
  }
  for (const entry of plan.candidates) {
    if (!scopes.some(scope => entry.path.startsWith(scope + '/') && !entry.path.slice(scope.length + 1).includes('/'))) {
      throw new Error('Invalid cleanup path: ' + entry.path);
    }
    fs.rmSync(path.join(plan.root, entry.path), { recursive: true });
  }
}

module.exports = { planCleanup, applyCleanup };
if (require.main === module) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, days: { type: 'string', default: '7' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: npm run clean:generated -- [--days 7] [--apply]\nPreviews old generated outputs; --apply deletes them. Stop builds/profilers first.\nPin outputs with .keep; canonical bundles and latest VSIXs are retained.');
  } else {
    const plan = planCleanup(path.resolve(__dirname, '..'), Number(values.days));
    for (const entry of plan.candidates) { console.log((values.apply ? 'Remove ' : 'Would remove ') + entry.path + ' (' + gib(entry.bytes) + ')'); }
    if (values.apply) { applyCleanup(plan); }
    console.log(`${values.apply ? 'Removed' : 'Eligible'}: ${plan.candidates.length} entries / ${gib(plan.candidates.reduce((sum, entry) => sum + entry.bytes, 0))}`);
    console.log(`Retained: ${plan.retained.length} entries / ${gib(plan.retained.reduce((sum, entry) => sum + entry.bytes, 0))}`);
    if (!values.apply) { console.log('Preview only. Add --apply to delete the listed outputs.'); }
  }
}
