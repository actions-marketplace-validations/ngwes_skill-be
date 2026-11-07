import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runner } from '../src/adapters/common.js';
import {
  installFolder,
  installPackages,
  readPackageList,
  removePackages,
} from '../src/code-tests/packages.js';
import { runProcess, type ProcessOptions, type ProcessResult } from '../src/process.js';
import { ConfigError } from '../src/types.js';

const ISSUE = 'https://github.com/ngwes/skill-be/issues/32';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'skill-be-packages-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes `test-packages.json` in the temporary folder and returns its path. */
async function listFile(content: unknown): Promise<string> {
  const file = path.join(root, 'test-packages.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as Error;
}

/** A runner that records its calls and answers with `result`, or rejects when it is an error. */
function fakeRunner(
  result: Partial<ProcessResult> | Error = {},
  during: (opts: ProcessOptions) => void = () => {},
): { run: Runner; calls: ProcessOptions[] } {
  const calls: ProcessOptions[] = [];
  const run: Runner = async (opts) => {
    calls.push(opts);
    during(opts);
    if (result instanceof Error) throw result;
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...result };
  };
  return { run, calls };
}

const hashOf = (specs: string[]): string =>
  createHash('sha256').update(specs.join('\n')).digest('hex');

const depsFolder = (hash: string): string =>
  path.join(root, '.skill-be', 'deps', hash.slice(0, 16));

describe('readPackageList', () => {
  it('reads npm specs and makes local paths absolute', async () => {
    const file = await listFile({
      npm: [
        '@ngwes/mini-fp@^2.0.0',
        'express@5',
        'git+https://example.com/lib.git#v1',
        './local-pkg',
        '../sibling',
        './libs/pkg-1.0.0.tgz',
      ],
    });
    expect(await readPackageList(file)).toEqual([
      '@ngwes/mini-fp@^2.0.0',
      'express@5',
      'git+https://example.com/lib.git#v1',
      path.join(root, 'local-pkg'),
      path.join(path.dirname(root), 'sibling'),
      path.join(root, 'libs', 'pkg-1.0.0.tgz'),
    ]);
  });

  it('keeps an absolute path as it is', async () => {
    const absolute = path.join(os.tmpdir(), 'elsewhere', 'pkg');
    const file = await listFile({ npm: [absolute] });
    expect(await readPackageList(file)).toEqual([absolute]);
  });

  it('resolves a file: spec against the folder of the list, keeping the prefix', async () => {
    const absolute = path.join(os.tmpdir(), 'elsewhere', 'pkg');
    const file = await listFile({
      npm: ['file:../lib', 'file:./libs/pkg.tgz', `file:${absolute}`],
    });
    expect(await readPackageList(file)).toEqual([
      `file:${path.resolve(root, '../lib')}`,
      `file:${path.join(root, 'libs', 'pkg.tgz')}`,
      `file:${absolute}`,
    ]);
  });

  it.skipIf(process.platform !== 'win32')('treats a drive letter as a local path', async () => {
    const file = await listFile({ npm: ['D:\\libs\\pkg', 'd:/libs/other'] });
    expect(await readPackageList(file)).toEqual(['D:\\libs\\pkg', 'd:\\libs\\other']);
  });

  it('reads a list without an npm section as no packages', async () => {
    expect(await readPackageList(await listFile({}))).toEqual([]);
    expect(await readPackageList(await listFile({ npm: [] }))).toEqual([]);
  });

  it('rejects an unsupported language section', async () => {
    const file = await listFile({ npm: ['express@5'], pip: ['requests'] });
    const error = await failure(readPackageList(file));
    expect(error.message).toBe(`${file}: "pip" packages are not supported yet (see ${ISSUE})`);
  });

  it('rejects a missing list file', async () => {
    const file = path.join(root, 'absent.json');
    const error = await failure(readPackageList(file));
    expect(error.message).toBe(`${file}: the package list does not exist`);
  });

  it('rejects a list that is not valid JSON', async () => {
    const file = await listFile('{ "npm": [');
    const error = await failure(readPackageList(file));
    expect(error.message).toContain(`${file}: invalid JSON (`);
  });

  it('rejects a list that is not an object', async () => {
    const file = await listFile(['express@5']);
    const error = await failure(readPackageList(file));
    expect(error.message).toBe(`${file}: the list must be an object like { "npm": ["pkg@1"] }`);
  });

  it('rejects an npm section that is not a list of specs', async () => {
    for (const npm of ['express@5', ['express@5', 3], ['']]) {
      const file = await listFile({ npm });
      const error = await failure(readPackageList(file));
      expect(error.message).toBe(`${file}: "npm" must be a list of package specs (strings)`);
    }
  });
});

describe('installPackages', () => {
  const specs = ['@ngwes/mini-fp@^2.0.0', 'express@5'];

  it('installs into a folder named by the hash and writes the marker', async () => {
    const hash = hashOf(specs);
    const dir = depsFolder(hash);
    const beforeNpm: { packageJson: unknown; marker: boolean }[] = [];
    const { run, calls } = fakeRunner({}, () => {
      beforeNpm.push({
        packageJson: existsSync(path.join(dir, 'package.json'))
          ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
          : null,
        marker: existsSync(path.join(dir, '.skill-be-installed')),
      });
    });

    expect(await installPackages(specs, root, run)).toEqual({ dir, reused: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bin: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--no-package-lock', ...specs],
      cwd: dir,
    });
    expect(calls[0]?.timeoutMs).toBeGreaterThanOrEqual(5 * 60_000);
    // npm ran in a folder that already had its package.json, and before the marker existed.
    expect(beforeNpm).toEqual([{ packageJson: { private: true, type: 'module' }, marker: false }]);
    expect(await readFile(path.join(dir, '.skill-be-installed'), 'utf8')).toBe(hash);
  });

  it('reuses a folder whose marker matches without running npm', async () => {
    const first = fakeRunner();
    const installed = await installPackages(specs, root, first.run);
    expect(installed.reused).toBe(false);

    const second = fakeRunner();
    expect(await installPackages(specs, root, second.run)).toEqual({
      dir: installed.dir,
      reused: true,
    });
    expect(second.calls).toEqual([]);
  });

  it('installs again into another folder when the specs change', async () => {
    const { run, calls } = fakeRunner();
    const first = await installPackages(specs, root, run);
    const second = await installPackages([...specs, 'zod@4'], root, run);
    expect(second.reused).toBe(false);
    expect(second.dir).not.toBe(first.dir);
    expect(calls).toHaveLength(2);
  });

  it('installs again when the marker holds another hash', async () => {
    const { run, calls } = fakeRunner();
    const { dir } = await installPackages(specs, root, run);
    await writeFile(path.join(dir, '.skill-be-installed'), 'something else');

    expect((await installPackages(specs, root, run)).reused).toBe(false);
    expect(calls).toHaveLength(2);
    expect(await readFile(path.join(dir, '.skill-be-installed'), 'utf8')).toBe(hashOf(specs));
  });

  it('removes what a folder without its marker holds before installing again', async () => {
    const dir = depsFolder(hashOf(specs));
    const leftover = path.join(dir, 'node_modules', 'half-installed', 'index.js');
    await mkdir(path.dirname(leftover), { recursive: true });
    await writeFile(leftover, '');
    const seen: boolean[] = [];
    const { run } = fakeRunner({}, () => seen.push(existsSync(leftover)));

    expect(await installPackages(specs, root, run)).toEqual({ dir, reused: false });
    expect(seen).toEqual([false]);
    expect(existsSync(leftover)).toBe(false);
  });

  it("copies the project's .npmrc into the folder before npm runs", async () => {
    const npmrc = 'registry=https://registry.example.com/\n';
    await writeFile(path.join(root, '.npmrc'), npmrc);
    const dir = depsFolder(hashOf(specs));
    const seen: (string | null)[] = [];
    const { run } = fakeRunner({}, (opts) => {
      const copy = path.join(opts.cwd!, '.npmrc');
      seen.push(existsSync(copy) ? readFileSync(copy, 'utf8') : null);
    });

    // The folder is the one of the specs alone: the .npmrc is not part of the hash.
    expect(await installPackages(specs, root, run)).toEqual({ dir, reused: false });
    expect(seen).toEqual([npmrc]);
  });

  it('runs npm without an .npmrc when the project has none', async () => {
    const seen: boolean[] = [];
    const { run } = fakeRunner({}, (opts) => {
      seen.push(existsSync(path.join(opts.cwd!, '.npmrc')));
    });
    await installPackages(specs, root, run);
    expect(seen).toEqual([false]);
  });

  it('names the folder it installs into before installing', () => {
    expect(installFolder(specs, root)).toBe(depsFolder(hashOf(specs)));
  });

  it("reports a failed install with npm's output", async () => {
    const stderr = 'npm error code E404\nnpm error 404 Not Found - GET /no-such-package\n';
    const { run, calls } = fakeRunner({ code: 1, stderr });

    const error = await failure(installPackages(['no-such-package'], root, run));
    expect(error.message).toContain('exit code 1');
    expect(error.message).toContain('404 Not Found - GET /no-such-package');
    expect(calls).toHaveLength(1);
    // No marker: the next call installs again instead of trusting a broken folder.
    const retry = fakeRunner();
    expect((await installPackages(['no-such-package'], root, retry.run)).reused).toBe(false);
    expect(retry.calls).toHaveLength(1);
  });

  it('keeps only the end of a long npm output', async () => {
    const stderr = `START-OF-OUTPUT ${'x'.repeat(5000)} END-OF-OUTPUT`;
    const error = await failure(
      installPackages(specs, root, fakeRunner({ code: 1, stderr }).run),
    );
    expect(error.message).toContain('END-OF-OUTPUT');
    expect(error.message).not.toContain('START-OF-OUTPUT');
    expect(error.message.length).toBeLessThan(1500);
  });

  it('reports an install that timed out', async () => {
    const { run } = fakeRunner({ code: null, timedOut: true });
    const error = await failure(installPackages(specs, root, run));
    expect(error.message).toContain('timed out');
  });

  it('reports npm missing', async () => {
    const { run } = fakeRunner(new Error('Could not start "npm": spawn npm ENOENT'));
    const error = await failure(installPackages(specs, root, run));
    expect(error.message).toContain('Could not start "npm": spawn npm ENOENT');
  });

  it('names the spec that cmd.exe cannot carry', async () => {
    const reason =
      'Could not start "npm": An argument with a percent sign cannot be passed to npm ' +
      'through cmd.exe';
    const { run } = fakeRunner(new Error(reason));
    const error = await failure(installPackages(['express@5', 'C:\\100%\\pkg'], root, run));
    expect(error.message).toContain('"C:\\100%\\pkg"');
    expect(error.message).toContain('percent sign');
  });

  it('creates the folder for an empty list without running npm', async () => {
    const { run, calls } = fakeRunner();
    const hash = hashOf([]);
    const dir = depsFolder(hash);

    expect(await installPackages([], root, run)).toEqual({ dir, reused: false });
    expect(calls).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))).toEqual({
      private: true,
      type: 'module',
    });
    expect(await readFile(path.join(dir, '.skill-be-installed'), 'utf8')).toBe(hash);
    expect(await installPackages([], root, run)).toEqual({ dir, reused: true });
  });
});

describe('removePackages', () => {
  it('deletes the folder', async () => {
    const { dir } = await installPackages(['express@5'], root, fakeRunner().run);
    await mkdir(path.join(dir, 'node_modules', 'express'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'express', 'index.js'), '');

    await removePackages(dir);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(root, '.skill-be', 'deps'))).toBe(true);
  });

  it('accepts a folder that is already gone', async () => {
    await expect(removePackages(path.join(root, 'nothing-here'))).resolves.toBeUndefined();
  });
});

/** True when `npm` runs; the real-npm case is skipped otherwise. */
const hasNpm = await runProcess({
  bin: 'npm',
  args: ['--version'],
  stdin: '',
  timeoutMs: 30_000,
}).then(
  (result) => result.code === 0,
  () => false,
);

describe('with the real npm', () => {
  it.skipIf(!hasNpm)(
    'installs a local package folder with the real npm',
    { timeout: 120_000 },
    async () => {
      const library = path.join(root, 'tiny-lib');
      await mkdir(library);
      await writeFile(
        path.join(library, 'package.json'),
        JSON.stringify({ name: 'tiny-lib', version: '1.0.0', type: 'module', main: 'index.js' }),
      );
      await writeFile(path.join(library, 'index.js'), 'export const answer = 42;\n');
      const file = await listFile({ npm: ['./tiny-lib'] });

      const specs = await readPackageList(file);
      const { dir, reused } = await installPackages(specs, root);

      expect(reused).toBe(false);
      expect(await readFile(path.join(dir, 'node_modules', 'tiny-lib', 'index.js'), 'utf8')).toBe(
        'export const answer = 42;\n',
      );
      expect(await readFile(path.join(dir, '.skill-be-installed'), 'utf8')).toBe(hashOf(specs));
      expect((await installPackages(specs, root)).reused).toBe(true);

      await removePackages(dir);
      expect(existsSync(dir)).toBe(false);
      // The folder was linked into node_modules; deleting the link leaves the library alone.
      expect(existsSync(path.join(library, 'index.js'))).toBe(true);
    },
  );
});
