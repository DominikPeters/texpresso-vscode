import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function diagnostics(root: string, output: string, debug: string): Promise<void> {
  const target = process.env.TEXPRESSO_TEST_ARTIFACTS;
  if (!target) { return; }
  const destination = path.join(target, path.basename(root));
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'compiler.txt'), output);
  await fs.writeFile(path.join(destination, 'engine.txt'), debug);
  await fs.cp(root, path.join(destination, 'project'), { recursive: true });
}
