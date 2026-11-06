import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runner } from '../src/adapters/common.js';
import { prepareCodeTests, type CodeTests } from '../src/code-tests/runtime.js';
import type { ProcessOptions } from '../src/process.js';
import { ConfigError, type Config, type Scenario, type SkillSuite } from '../src/types.js';

// Each case starts a child or two; room for that on a slow machine.
const CHILD_TEST = { timeout: 30_000 };

let root: string;
let testsDir: string;
let prepared: CodeTests[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'skill-be-runtime-'));
  testsDir = path.join(root, 'skill-tests');
  prepared = [];
});

afterEach(async () => {
  for (const codeTests of prepared) await codeTests.dispose();
  await rm(root, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    root,
    configPath: path.join(root, 'skill-be.yaml'),
    skills: path.join(root, 'skills'),
    evals: path.join(root, 'evals'),
    models: [{ adapter: 'fake', id: 'm1' }],
    grader: { adapter: 'fake', id: 'grader' },
    reps: 1,
    gradings: 1,
    concurrency: 4,
    timeoutSeconds: 120,
    results: path.join(root, 'results'),
    resultFile: path.join(root, 'skill-be.result.json'),
    withSkillTemplate: '{{skill}}\n{{task}}',
    graderPrompt: null,
    gate: { regressionOnCritical: true, blockOnZero: true, blockOnErrors: true },
    checks: { typecheck: false, coverage: false },
    triage: { model: null },
    codeTests: {
      tests: testsDir,
      packages: null,
      packagesBySkill: {},
      testTimeoutSeconds: 5,
      answerTimeoutSeconds: 20,
      allow: [],
    },
  };
}

const judgeScenario = (id: string): Scenario => ({
  id,
  critical: false,
  prompt: `Task for ${id}`,
  criteria: ['is clear'],
  output: null,
  tests: [],
});

const contractScenario = (id: string): Scenario => ({
  ...judgeScenario(id),
  criteria: [],
  output: { result: 'a function (a, b) => number' },
});

/** Writes `content` at `rel` under the temporary root and returns its absolute path. */
async function put(rel: string, content: string): Promise<string> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** Every file under a folder, at any depth, sorted (as discovery lists `codeFiles`). */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    files.push(...(entry.isDirectory() ? await filesUnder(file) : [file]));
  }
  return files.sort();
}

/**
 * A suite whose scenarios with a contract have their test file at `<tests>/<skill>/<id>.test.ts`;
 * its code files are every file under `<tests>/<skill>/` and `<tests>/_shared/`.
 */
async function makeSuite(
  name: string,
  scenarios: Scenario[],
  packageList: string | null = null,
): Promise<SkillSuite> {
  const contracts = scenarios.filter((scenario) => scenario.output !== null);
  const testFiles = Object.fromEntries(
    contracts.map((scenario) => [scenario.id, path.join(testsDir, name, `${scenario.id}.test.ts`)]),
  );
  const codeFiles =
    contracts.length === 0
      ? []
      : [
          ...(await filesUnder(path.join(testsDir, name))),
          ...(await filesUnder(path.join(testsDir, '_shared'))),
        ];
  return {
    name,
    skillPath: path.join(root, 'skills', name, 'SKILL.md'),
    skillText: 'the skill',
    evalPath: path.join(root, 'evals', `${name}.json`),
    scenarios,
    testFiles,
    codeFiles,
    packageList,
  };
}

/**
 * A runner standing in for npm: it records its calls and installs each local folder spec by
 * copying it to `node_modules/<its package name>` of the folder it runs in.
 */
function fakeNpm(): { run: Runner; calls: ProcessOptions[] } {
  const calls: ProcessOptions[] = [];
  const run: Runner = async (opts) => {
    calls.push(opts);
    for (const spec of opts.args.filter((arg) => path.isAbsolute(arg))) {
      const { name } = JSON.parse(await readFile(path.join(spec, 'package.json'), 'utf8')) as {
        name: string;
      };
      await cp(spec, path.join(opts.cwd!, 'node_modules', name), { recursive: true });
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false };
  };
  return { run, calls };
}

/** A package `local-lib` in the temporary root and a package list that names it. */
async function localPackage(): Promise<string> {
  await put(
    'local-lib/package.json',
    JSON.stringify({ name: 'local-lib', type: 'module', exports: './index.js' }),
  );
  await put('local-lib/index.js', 'export const triple = (n) => n * 3;\n');
  return put('test-packages.json', JSON.stringify({ npm: ['./local-lib'] }));
}

const IMPORT_TEST = "import { test } from '@ngwes/skill-be/testing';\n";

const answer = (code: string): string => `Here you go:\n\n\`\`\`ts\n${code}\n\`\`\`\n`;

const SUM = answer('export const result = (a, b) => a + b;');

async function prepare(
  suites: SkillSuite[],
  opts: Partial<Parameters<typeof prepareCodeTests>[2]> = {},
): Promise<CodeTests> {
  const codeTests = await prepareCodeTests(makeConfig(), suites, {
    keepDeps: false,
    log: () => {},
    run: fakeNpm().run,
    ...opts,
  });
  prepared.push(codeTests);
  return codeTests;
}

const depsRoot = (): string => path.join(root, '.skill-be', 'deps');

describe('prepareCodeTests', () => {
  it('fills scenario.tests with the names in order', CHILD_TEST, async () => {
    await put(
      'skill-tests/sum/adds.test.ts',
      `${IMPORT_TEST}test('zeta first', () => {});\ntest('alpha second', () => {});\n`,
    );
    const suite = await makeSuite('sum', [judgeScenario('judged'), contractScenario('adds')]);
    const { suites } = await prepare([suite]);
    expect(suites[0]!.scenarios.map((scenario) => scenario.tests)).toEqual([
      [],
      ['zeta first', 'alpha second'],
    ]);
    // The suite it was given is not changed.
    expect(suite.scenarios[1]!.tests).toEqual([]);
  });

  it('runs an answer and returns one outcome per test', CHILD_TEST, async () => {
    await put(
      'skill-tests/sum/adds.test.ts',
      [
        IMPORT_TEST,
        "test('adds', ({ result }) => { if (result(1, 2) !== 3) throw new Error('not 3'); });",
        "test('adds wrongly', ({ result }) => {",
        "  if (result(2, 2) !== 5) throw new Error('expected 5, got ' + result(2, 2));",
        '});',
      ].join('\n'),
    );
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')])]);
    const typed = 'export const result = (a: number, b: number): number => a + b;';
    expect(await codeTests.run('sum', 'adds', answer(typed))).toEqual({
      outcomes: [
        { name: 'adds', pass: true, message: '' },
        { name: 'adds wrongly', pass: false, message: 'expected 5, got 4' },
      ],
      infraError: null,
    });
  });

  it('fails every test when the answer has no code block', CHILD_TEST, async () => {
    await put(
      'skill-tests/sum/adds.test.ts',
      `${IMPORT_TEST}test('one', () => {});\ntest('two', () => {});\n`,
    );
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')])]);
    expect(await codeTests.run('sum', 'adds', 'I would add the numbers.')).toEqual({
      outcomes: [
        { name: 'one', pass: false, message: 'no code block in the answer' },
        { name: 'two', pass: false, message: 'no code block in the answer' },
      ],
      infraError: null,
    });
  });

  it("a test file's relative helper import works", CHILD_TEST, async () => {
    await put('skill-tests/sum/helpers/numbers.ts', 'export const two: number = 2;\n');
    await put(
      'skill-tests/sum/adds.test.ts',
      [
        IMPORT_TEST,
        "import { two } from './helpers/numbers.js';",
        "test('doubles', ({ result }) => { if (result(two, two) !== 4) throw new Error('no'); });",
      ].join('\n'),
    );
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')])]);
    expect(await codeTests.run('sum', 'adds', SUM)).toEqual({
      outcomes: [{ name: 'doubles', pass: true, message: '' }],
      infraError: null,
    });
  });

  it('a helper in _shared works', CHILD_TEST, async () => {
    await put(
      'skill-tests/_shared/check.ts',
      [
        'export function same(actual: unknown, expected: unknown): void {',
        '  if (actual !== expected) throw new Error(`got ${String(actual)}`);',
        '}',
      ].join('\n'),
    );
    await put(
      'skill-tests/sum/adds.test.ts',
      [
        IMPORT_TEST,
        "import { same } from '../_shared/check.js';",
        "test('adds', ({ result }) => same(result(1, 1), 2));",
        "test('reports', ({ result }) => same(result(1, 1), 3));",
      ].join('\n'),
    );
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')])]);
    expect((await codeTests.run('sum', 'adds', SUM)).outcomes).toEqual([
      { name: 'adds', pass: true, message: '' },
      { name: 'reports', pass: false, message: 'got 2' },
    ]);
  });

  it('the answer and the tests both import the listed package', CHILD_TEST, async () => {
    const list = await localPackage();
    await put(
      'skill-tests/sum/adds.test.ts',
      [
        IMPORT_TEST,
        "import { triple } from 'local-lib';",
        "test('triples', ({ result }) => {",
        "  if (result(2) !== triple(2)) throw new Error('got ' + result(2));",
        '});',
      ].join('\n'),
    );
    const npm = fakeNpm();
    const lines: string[] = [];
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')], list)], {
      run: npm.run,
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([
      `installed the test packages of ${list} in ${npm.calls[0]!.cwd}`,
    ]);
    expect(npm.calls).toHaveLength(1);
    expect(npm.calls[0]!.args).toContain(path.join(root, 'local-lib'));
    const code = [
      "import { triple } from 'local-lib';",
      'export const result = (n: number) => triple(n);',
    ].join('\n');
    expect(await codeTests.run('sum', 'adds', answer(code))).toEqual({
      outcomes: [{ name: 'triples', pass: true, message: '' }],
      infraError: null,
    });
  });

  it('installs a list that several skills share once', CHILD_TEST, async () => {
    const list = await localPackage();
    await put('skill-tests/one/a.test.ts', `${IMPORT_TEST}test('a', () => {});\n`);
    await put('skill-tests/two/b.test.ts', `${IMPORT_TEST}test('b', () => {});\n`);
    const npm = fakeNpm();
    const { suites } = await prepare(
      [
        await makeSuite('one', [contractScenario('a')], list),
        await makeSuite('two', [contractScenario('b')], list),
      ],
      { run: npm.run },
    );
    expect(npm.calls).toHaveLength(1);
    expect(suites.map((suite) => suite.scenarios[0]!.tests)).toEqual([['a'], ['b']]);
  });

  it('keeps the install folder with keepDeps and removes it otherwise', CHILD_TEST, async () => {
    const list = await localPackage();
    await put('skill-tests/sum/adds.test.ts', `${IMPORT_TEST}test('one', () => {});\n`);
    const suite = await makeSuite('sum', [contractScenario('adds')], list);

    const kept = await prepare([suite], { keepDeps: true });
    await kept.run('sum', 'adds', answer('export const result = 1;'));
    const [installDir] = await readdir(depsRoot());
    const install = path.join(depsRoot(), installDir!);
    expect((await readdir(install)).some((entry) => entry.startsWith('run-'))).toBe(true);
    await kept.dispose();
    await kept.dispose();
    expect(existsSync(path.join(install, 'node_modules', 'local-lib'))).toBe(true);
    expect((await readdir(install)).some((entry) => entry.startsWith('run-'))).toBe(false);

    const removed = await prepare([suite], { keepDeps: false });
    await removed.dispose();
    expect(existsSync(install)).toBe(false);
  });

  it('passes judge-only suites through without installing anything', async () => {
    const suite = await makeSuite('judged', [judgeScenario('s1')]);
    const npm = fakeNpm();
    const codeTests = await prepare([suite], {
      run: npm.run,
      loadTypescript: () => Promise.reject(new Error('not needed')),
    });
    expect(codeTests.suites).toEqual([suite]);
    expect(codeTests.suites[0]).toBe(suite);
    expect(npm.calls).toEqual([]);
    expect(existsSync(path.join(root, '.skill-be'))).toBe(false);
    await codeTests.dispose();
  });

  it('throws the ConfigError of a missing TypeScript when a contract exists', async () => {
    await put('skill-tests/sum/adds.test.ts', `${IMPORT_TEST}test('one', () => {});\n`);
    const suite = await makeSuite('sum', [contractScenario('adds')]);
    const preparing = prepare([suite], {
      loadTypescript: () => Promise.reject(new Error('Cannot find module typescript')),
    });
    await expect(preparing).rejects.toThrow(ConfigError);
    await expect(preparing).rejects.toThrow(/code tests.*"typescript" package/);
    expect(existsSync(path.join(root, '.skill-be'))).toBe(false);
  });

  it('names the skill when its package list does not exist', async () => {
    await put('skill-tests/sum/adds.test.ts', `${IMPORT_TEST}test('one', () => {});\n`);
    const missing = path.join(root, 'missing-packages.json');
    const suite = await makeSuite('sum', [contractScenario('adds')], missing);
    const preparing = prepare([suite]);
    await expect(preparing).rejects.toThrow(ConfigError);
    await expect(preparing).rejects.toThrow(
      `${missing}: the package list does not exist (needed by skill "sum")`,
    );
  });

  it(
    'names the source test file when it throws on load, and cleans up',
    CHILD_TEST,
    async () => {
      const source = await put(
        'skill-tests/sum/adds.test.ts',
        `${IMPORT_TEST}throw new Error('broken helper');\n`,
      );
      const preparing = prepare([await makeSuite('sum', [contractScenario('adds')])]);
      await expect(preparing).rejects.toThrow(ConfigError);
      await expect(preparing).rejects.toThrow(`the test file ${source} threw on load`);
      await expect(preparing).rejects.toThrow('broken helper');
      expect(await readdir(depsRoot())).toEqual([]);
    },
  );

  it('rejects a run of a skill or scenario it did not prepare', CHILD_TEST, async () => {
    await put('skill-tests/sum/adds.test.ts', `${IMPORT_TEST}test('one', () => {});\n`);
    const codeTests = await prepare([await makeSuite('sum', [contractScenario('adds')])]);
    const unknownSkill = codeTests.run('other', 'adds', answer('x'));
    await expect(unknownSkill).rejects.toThrow(
      'no code tests for scenario "adds" of skill "other"',
    );
    await expect(unknownSkill).rejects.not.toBeInstanceOf(ConfigError);
    await expect(codeTests.run('sum', 'judged', answer('x'))).rejects.toThrow(
      'no code tests for scenario "judged" of skill "sum"',
    );
  });
});
