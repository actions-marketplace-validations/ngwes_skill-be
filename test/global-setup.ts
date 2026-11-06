import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds `dist/` once per test run: the code tests run in a child process on the compiled
 * `dist/code-tests/child.js`, which Node 20 cannot run from the TypeScript source.
 */
export default function setup(): void {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });
}
