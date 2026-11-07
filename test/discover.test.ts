import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTests } from '../src/code-tests/discover.js';
import { ConfigError, type Scenario } from '../src/types.js';

let tests: string;

beforeEach(async () => {
  tests = await mkdtemp(path.join(os.tmpdir(), 'skill-be-discover-'));
});

afterEach(async () => {
  await rm(tests, { recursive: true, force: true });
});

/** Creates `<tests>/<name>` (and its folders) and returns its path. */
async function put(name: string, content = '// test\n'): Promise<string> {
  const file = path.join(tests, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** A scenario with an output contract, or without one when `output` is null. */
const scenario = (
  id: string,
  output: Record<string, string> | null = { result: 'a number' },
): Scenario => ({
  id,
  critical: false,
  prompt: `Task for ${id}`,
  criteria: [],
  output,
  tests: [],
});

async function failure(promise: Promise<unknown>): Promise<ConfigError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

describe('discoverTests', () => {
  it('maps each <id>.test.ts to its scenario', async () => {
    const first = await put('s/first.test.ts');
    const second = await put('s/second.test.ts');

    const found = await discoverTests(tests, 's', [scenario('first'), scenario('second')]);

    expect(found.testFiles).toEqual({ first, second });
  });

  it('lists helpers and the _shared folder in codeFiles, sorted', async () => {
    await put('s/b.test.ts');
    await put('s/helpers/util.ts');
    await put('s/a.test.ts');
    await put('s/data.json', '{}');
    await put('_shared/common.ts');
    await put('other/never.test.ts');
    await put('other/helper.ts');

    const found = await discoverTests(tests, 's', [scenario('a'), scenario('b')]);

    expect(found.codeFiles).toEqual(
      ['_shared/common.ts', 's/a.test.ts', 's/b.test.ts', 's/data.json', 's/helpers/util.ts'].map(
        (name) => path.join(tests, ...name.split('/')),
      ),
    );
  });

  it('sorts by the path written with forward slashes, whatever the platform', async () => {
    // '/' sorts before 'B' but '\\' sorts after it: a sort on the native path would differ.
    await put('s/aB.ts');
    await put('s/a/b.ts');

    const found = await discoverTests(tests, 's', []);

    expect(found.codeFiles).toEqual([
      path.join(tests, 's', 'a', 'b.ts'),
      path.join(tests, 's', 'aB.ts'),
    ]);
  });

  it('takes only a file directly in the skill folder for a test', async () => {
    const own = await put('s/a.test.ts');
    const nested = await put('s/helpers/inner.test.ts');
    const shared = await put('_shared/extra.test.ts');

    const found = await discoverTests(tests, 's', [scenario('a')]);

    expect(found.testFiles).toEqual({ a: own });
    expect(found.codeFiles).toEqual([shared, own, nested]);
  });

  it('rejects a test file that matches no scenario', async () => {
    await put('s/a.test.ts');
    const ghost = await put('s/ghost.test.ts');

    const error = await failure(discoverTests(tests, 's', [scenario('a')]));

    expect(error.message).toBe(`${ghost}: no scenario "ghost" in the eval file of skill "s"`);
  });

  it('rejects a scenario with an output contract and no test file', async () => {
    const error = await failure(discoverTests(tests, 's', [scenario('x')]));

    expect(error.message).toBe(
      `scenario "x" of skill "s" has an "output" contract but no test file ` +
        path.join(tests, 's', 'x.test.ts'),
    );
  });

  it('rejects a test file for a scenario without an output contract', async () => {
    const file = await put('s/x.test.ts');

    const error = await failure(discoverTests(tests, 's', [scenario('x', null)]));

    expect(error.message).toBe(`${file}: scenario "x" has no "output" contract`);
  });

  it('rejects an output contract on a scenario id that cannot be a file name', async () => {
    const error = await failure(discoverTests(tests, 's', [scenario('a/b')]));

    expect(error.message).toBe(
      'scenario "a/b" of skill "s": an id with tests must be a valid file name',
    );
  });

  it('accepts any id on a scenario without an output contract', async () => {
    const found = await discoverTests(tests, 's', [scenario('a/b', null)]);

    expect(found).toEqual({ testFiles: {}, codeFiles: [] });
  });

  it('returns empty results when the skill has no test folder and no contract', async () => {
    const found = await discoverTests(tests, 's', [scenario('a', null)]);

    expect(found).toEqual({ testFiles: {}, codeFiles: [] });
  });

  it('returns empty results when the tests folder itself does not exist', async () => {
    const found = await discoverTests(path.join(tests, 'missing'), 's', [scenario('a', null)]);

    expect(found).toEqual({ testFiles: {}, codeFiles: [] });
  });
});
