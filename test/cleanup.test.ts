import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

// `rm` stays the real one, except where a case makes it fail for the install folders.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const { rm: realRm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const CODE_TESTS = fileURLToPath(new URL('./fixtures/code-tests/', import.meta.url));

// A run of the fixture: a child to list the tests, then one per arm.
const RUN = { timeout: 60_000 };

const RETRIES = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'skill-be-cleanup-'));
});

afterEach(async () => {
  vi.mocked(rm).mockImplementation(realRm);
  vi.mocked(rm).mockClear();
  await realRm(root, { recursive: true, force: true });
});

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd: root,
  });
  return { code, stdout, stderr };
}

/** The code-tests fixture without its package list, so that no case needs npm. */
async function offlineFixture(testFile: string): Promise<void> {
  await cp(CODE_TESTS, root, { recursive: true });
  await unlink(path.join(root, 'test-packages.json'));
  await writeFile(path.join(root, 'skill-tests', 'sum', 'adds.test.ts'), testFile);
}

const ADDS = [
  "import { test } from '@ngwes/skill-be/testing';",
  "test('adds', ({ result }) => { if (result(1, 2) !== 3) throw new Error('not 3'); });",
  '',
].join('\n');

const depsDir = (): string => path.join(root, '.skill-be', 'deps');

/**
 * Makes `rm` fail for the run folders and the installed folders under `.skill-be/deps`, the ones
 * a dispose removes; returns the folders it was given.
 */
function failRemovals(): string[] {
  const attempts: string[] = [];
  vi.mocked(rm).mockImplementation(async (target, options) => {
    const dir = String(target);
    const disposed =
      path.basename(dir).startsWith('run-') || existsSync(path.join(dir, '.skill-be-installed'));
    if (!dir.startsWith(depsDir()) || !disposed) return realRm(target, options);
    attempts.push(dir);
    throw new Error(`EBUSY: resource busy or locked, rmdir '${dir}'`);
  });
  return attempts;
}

describe('a cleanup that fails', () => {
  it('keeps the exit code of a READY run and warns about each folder', RUN, async () => {
    await offlineFixture(ADDS);
    const attempts = failRemovals();

    const { code, stdout, stderr } = await cli('run');

    expect(code).toBe(0);
    expect(stdout).toMatch(/sum: READY/);
    // The run folder inside the install folder, then the install folder: both were tried.
    expect(attempts).toHaveLength(2);
    const [runDir, installDir] = attempts as [string, string];
    expect(path.dirname(runDir)).toBe(installDir);
    for (const dir of attempts) {
      expect(stderr).toContain(
        `warning: could not remove ${dir} (EBUSY: resource busy or locked, rmdir '${dir}')\n`,
      );
      expect(vi.mocked(rm)).toHaveBeenCalledWith(dir, RETRIES);
    }
  });

  it('keeps the config error of a preparation that fails', RUN, async () => {
    await offlineFixture("throw new Error('broken on purpose');\n");
    const attempts = failRemovals();

    const { code, stderr } = await cli('run');

    expect(code).toBe(2);
    expect(stderr).toContain('broken on purpose');
    expect(attempts).toHaveLength(2);
    for (const dir of attempts) expect(stderr).toContain(`warning: could not remove ${dir} (`);
  });
});
