const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');
const { productionFiles, productionManifest, validateBundle, sha256 } = require('./vsix-payload.cjs');
const { checkVSIX } = require('./check-vsix.cjs');

const root = path.resolve(__dirname, '..');
const { values } = parseArgs({ options: { target: { type: 'string' }, bundle: { type: 'string' }, out: { type: 'string' } } });
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { throw new Error(command + ' failed with exit code ' + result.status); }
}
if (!!values.target !== !!values.bundle) { throw new Error('--target and --bundle must be supplied together'); }
const bundle = values.bundle && path.resolve(values.bundle);
if (bundle && process.platform === 'win32') { throw new Error('Package Unix bundles on Linux or macOS to preserve executable permissions'); }
const nativeFiles = bundle ? validateBundle(bundle, values.target, root) : [];
run('npm', ['run', 'package'], root);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'txp-vsix-'));
try {
  for (const file of productionFiles.filter(file => file !== 'package.json')) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(stage, file));
  }
  const manifest = productionManifest(root);
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(path.join(root, '.vscodeignore'), path.join(stage, '.vscodeignore'));
  if (bundle) {
    for (const file of nativeFiles) {
      const destination = path.join(stage, 'runtime', values.target, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(bundle, file), destination);
      fs.chmodSync(destination, fs.statSync(path.join(bundle, file)).mode & 0o777);
    }
    fs.appendFileSync(path.join(stage, '.vscodeignore'), '\n!runtime/**\n');
  }
  const output = path.resolve(values.out || (bundle
    ? path.join(root, 'artifacts', `texpresso-${manifest.version}-${values.target}.vsix`)
    : path.join(root, 'artifacts', 'texpresso.vsix')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run('vsce', ['package', '--no-dependencies', '--out', output, ...(bundle ? ['--target', values.target] : [])], stage);
  checkVSIX(output, { bundle, target: values.target });
  fs.writeFileSync(output + '.sha256', sha256(fs.readFileSync(output)) + '  ' + path.basename(output) + '\n');
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
