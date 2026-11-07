/**
 * Finds the code tests of a skill by convention, with the file system alone: nothing is compiled
 * and no test code runs. The tests of skill `s` live in `<tests>/s/`, one file `<id>.test.ts` per
 * scenario with an `output` contract; everything else under `<tests>/s/` and `<tests>/_shared/` is
 * a helper.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { TryAsync, foldAsync, sequenceValidate } from '@ngwes/mini-fp';
import { check, fail, firstProblem, valueOrThrow, type Checked } from '../checked.js';
import { ConfigError, type Scenario } from '../types.js';

export type DiscoveredTests = {
  /** Scenario id -> absolute path of its `<id>.test.ts`. */
  testFiles: Record<string, string>;
  /**
   * Every file under `<tests>/<skill>/` and `<tests>/_shared/`, recursive, sorted: helpers
   * included.
   */
  codeFiles: string[];
};

const SHARED_FOLDER = '_shared';
const TEST_SUFFIX = '.test.ts';
/** Path separators, the characters Windows keeps out of file names, and control characters. */
const NOT_IN_A_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * The test files and the code files of a skill. A test is a file `<id>.test.ts` directly in
 * `<tests>/<skill>/`; the files in its subfolders and in `<tests>/_shared/` are helpers. A folder
 * that does not exist holds nothing.
 *
 * @throws ConfigError when a test file matches no scenario or one without an `output` contract,
 * when a scenario with a contract has no test file or an id that cannot be a file name.
 */
export async function discoverTests(
  testsDir: string,
  skill: string,
  scenarios: Scenario[],
): Promise<DiscoveredTests> {
  const skillDir = path.join(testsDir, skill);
  const own = await filesUnder(skillDir);
  const shared = await filesUnder(path.join(testsDir, SHARED_FOLDER));

  const tests = new Map<string, string>(
    own
      .filter((file) => path.dirname(file) === skillDir && file.endsWith(TEST_SUFFIX))
      .map((file) => [path.basename(file).slice(0, -TEST_SUFFIX.length), file]),
  );
  const found = problemsOf(skill, skillDir, scenarios, tests);

  return valueOrThrow(
    firstProblem(sequenceValidate(found)).map(() => ({
      testFiles: Object.fromEntries(tests),
      codeFiles: inPortableOrder([...own, ...shared], testsDir),
    })),
  );
}

/** One check per rule, in the order the rules are reported: file names, test files, then gaps. */
function problemsOf(
  skill: string,
  skillDir: string,
  scenarios: Scenario[],
  tests: Map<string, string>,
): Checked<string>[] {
  const contracts = scenarios.filter((scenario) => scenario.output !== null);

  const names = contracts.map((scenario) =>
    check(
      !NOT_IN_A_FILE_NAME.test(scenario.id),
      scenario.id,
      () =>
        `scenario "${scenario.id}" of skill "${skill}": ` +
        'an id with tests must be a valid file name',
    ),
  );

  const files = [...tests].map(([id, file]): Checked<string> => {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    if (scenario === undefined) {
      return fail(`${file}: no scenario "${id}" in the eval file of skill "${skill}"`);
    }
    return check(
      scenario.output !== null,
      file,
      () => `${file}: scenario "${id}" has no "output" contract`,
    );
  });

  const gaps = contracts.map((scenario) =>
    check(
      tests.has(scenario.id),
      scenario.id,
      () =>
        `scenario "${scenario.id}" of skill "${skill}" has an "output" contract but no test file ` +
        path.join(skillDir, `${scenario.id}${TEST_SUFFIX}`),
    ),
  );

  return [...names, ...files, ...gaps];
}

/** Every file under the folder, at any depth; none when there is no such folder. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await TryAsync.runAsync(() => readdir(dir, { withFileTypes: true })).match<
    Dirent[]
  >(
    (found) => found,
    (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw new ConfigError(`cannot read ${dir} (${(error as Error).message})`);
    },
  );

  return foldAsync<Dirent, string[]>(entries, [], async (files, entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? [...files, ...(await filesUnder(file))] : [...files, file];
  });
}

/**
 * The files ordered by their path from `root` written with forward slashes, so that the order, and
 * with it the fingerprint of the skill, is the same on every platform.
 */
function inPortableOrder(files: string[], root: string): string[] {
  const key = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  return [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
