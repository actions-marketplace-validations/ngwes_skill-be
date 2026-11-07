/**
 * The code tests of a run, prepared before the first model call: each package list is installed
 * once, the test files and helpers are transpiled into a run folder inside the install folder (so
 * that the test files and the answers import the listed packages), and every test file is listed.
 * Each answer then runs against its scenario's tests in a child process.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TryAsync } from '@ngwes/mini-fp';
import type { Runner } from '../adapters/common.js';
import { loadTypescript, type TypeScript, type TypescriptDeps } from '../checks/typescript.js';
import { ConfigError, type Config, type Scenario, type SkillSuite } from '../types.js';
import { extractAnswer, transpile } from './compile.js';
import { executeTests, listTests, type TestOutcome } from './execute.js';
import { REMOVE_FOLDER, installPackages, readPackageList, removePackages } from './packages.js';

export type CodeTestResult = { outcomes: TestOutcome[]; infraError: string | null };

export type CodeTests = {
  /** The suites with each scenario's `tests` filled with its test names. */
  suites: SkillSuite[];
  /**
   * Runs the scenario's tests against one model output (the whole answer text).
   *
   * @throws Error when the skill or the scenario has no prepared code tests.
   */
  run(skill: string, scenarioId: string, output: string): Promise<CodeTestResult>;
  /**
   * Deletes the run's compiled files, and the install folders unless `keepDeps`. A folder that
   * cannot be removed does not stop the others.
   *
   * @throws CleanupError naming every folder it could not remove.
   */
  dispose(): Promise<void>;
};

/** The folders a dispose could not remove: one `could not remove <dir> (<why>)` per folder. */
export class CleanupError extends Error {
  override name = 'CleanupError';

  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

/** The `warning: ...` lines of a dispose that failed, one per folder it could not remove. */
export function cleanupWarnings(error: unknown): string[] {
  const problems = error instanceof CleanupError ? error.problems : [messageOf(error)];
  return problems.map((problem) => `warning: ${problem}`);
}

export type PrepareOptions = TypescriptDeps & {
  /** Keeps the install folders for the next run. */
  keepDeps: boolean;
  log: (line: string) => void;
  /** Starts npm; `runProcess` unless a test passes a fake. */
  run?: Runner;
};

/**
 * skill-be's own built wrapper, which the compiled tests import. `src/` and `dist/` both sit one
 * level under the package root, so this is the same file from the source and from the build.
 */
const TESTING_URL = new URL('../../dist/testing.js', import.meta.url).href;

/** The failure of every test of an answer without a code block: the model's fault. */
const NO_CODE_BLOCK = 'no code block in the answer';

/** One scenario's compiled test file and the names it registers. */
type PreparedScenario = {
  /** The test file as the author wrote it, for messages. */
  source: string;
  compiled: string;
  names: string[];
  fields: string[];
};

/** Where a skill's tests run: its install folder and the run folder inside it. */
type PreparedSuite = {
  installDir: string;
  runDir: string;
  scenarios: Map<string, PreparedScenario>;
};

/**
 * Installs, transpiles and lists the code tests of `suites`, before any model call. A suite
 * without an output contract passes through untouched and needs neither TypeScript nor an
 * install. When preparing fails, what it created is removed (install folders kept with
 * `keepDeps`).
 *
 * @throws ConfigError when TypeScript is missing, a package list is missing or invalid or does
 * not install, or a test file throws on load or registers no tests.
 */
export async function prepareCodeTests(
  config: Config,
  suites: SkillSuite[],
  opts: PrepareOptions,
): Promise<CodeTests> {
  const testSuites = suites.filter(hasContracts);
  const installDirs = new Set<string>();
  const runDirs = new Set<string>();
  const prepared = new Map<string, PreparedSuite>();

  const dispose = async (): Promise<void> => {
    const removals = [
      ...[...runDirs].map((dir) => ({ dir, remove: () => rm(dir, REMOVE_FOLDER) })),
      ...(opts.keepDeps ? [] : [...installDirs]).map((dir) => ({
        dir,
        remove: () => removePackages(dir),
      })),
    ];
    const problems: string[] = [];
    for (const { dir, remove } of removals) {
      await TryAsync.runAsync(remove).onFail((error) => {
        problems.push(`could not remove ${dir} (${messageOf(error)})`);
      });
    }
    if (problems.length > 0) throw new CleanupError(problems);
  };

  if (testSuites.length === 0) {
    return { suites, run: async (skill, id) => notPrepared(skill, id), dispose };
  }

  const ts = await loadTypescript('code tests', config.root, opts);
  const testsDir = config.codeTests.tests;
  if (testsDir === null) throw new Error('suites with output contracts need codeTests.tests');

  let answers = 0;
  const run = async (skill: string, id: string, output: string): Promise<CodeTestResult> => {
    const suite = prepared.get(skill);
    const scenario = suite?.scenarios.get(id);
    if (suite === undefined || scenario === undefined) return notPrepared(skill, id);
    const code = extractAnswer(output);
    if (code === null) return everyTestFails(scenario.names, NO_CODE_BLOCK, null);

    answers += 1;
    const answerFile = path.join(suite.runDir, 'answers', `${answers}.js`);
    const writeError = await TryAsync.runAsync(() =>
      writeFile(answerFile, transpile(ts, code, 'answer.ts', TESTING_URL)),
    ).match<string | null>(
      () => null,
      (error) => `cannot write the answer ${answerFile} (${(error as Error).message})`,
    );
    if (writeError !== null) return everyTestFails(scenario.names, writeError, writeError);

    const result = await executeTests(
      {
        ...timeouts(config),
        testFile: scenario.compiled,
        answerFile,
        fields: scenario.fields,
        cwd: suite.installDir,
      },
      scenario.names,
    );
    return withSourceNames(result, scenario);
  };

  try {
    const dirs = await installLists(config, testSuites, opts, installDirs);
    const stamp = `run-${Date.now()}`;
    const written = new Set<string>();
    const filled: SkillSuite[] = [];
    for (const suite of suites) {
      const installDir = dirs.get(suite.name);
      if (installDir === undefined) {
        filled.push(suite);
        continue;
      }
      const runDir = path.join(installDir, stamp);
      runDirs.add(runDir);
      await mkdir(path.join(runDir, 'answers'), { recursive: true });
      for (const file of suite.codeFiles) {
        await compileFile(ts, file, compiledPath(runDir, testsDir, file), written);
      }
      const scenarios = new Map<string, PreparedScenario>();
      for (const scenario of suite.scenarios) {
        if (scenario.output === null) continue;
        const source = suite.testFiles[scenario.id]!;
        const compiled = compiledPath(runDir, testsDir, source);
        const names = await listOf(config, source, compiled, installDir);
        const fields = Object.keys(scenario.output);
        scenarios.set(scenario.id, { source, compiled, names, fields });
      }
      prepared.set(suite.name, { installDir, runDir, scenarios });
      filled.push({ ...suite, scenarios: suite.scenarios.map((s) => withTests(s, scenarios)) });
    }
    return { suites: filled, run, dispose };
  } catch (error) {
    // The error that stopped the preparation is the one to report; a cleanup problem only warns.
    await dispose().catch((cleanup: unknown) => cleanupWarnings(cleanup).forEach(opts.log));
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run of a skill or scenario without prepared code tests: a programming error. */
function notPrepared(skill: string, id: string): never {
  throw new Error(`no code tests for scenario "${id}" of skill "${skill}"`);
}

function hasContracts(suite: SkillSuite): boolean {
  return suite.scenarios.some((scenario) => scenario.output !== null);
}

/**
 * Reads each distinct package list and installs each distinct set of specs once, in order: the
 * installs are not locked against each other. A suite without a list installs the empty one, so
 * its answers still run in a folder whose `package.json` makes them ES modules. Every folder is
 * added to `installDirs` as soon as it is installed.
 *
 * @returns skill name -> its install folder.
 */
async function installLists(
  config: Config,
  suites: SkillSuite[],
  opts: PrepareOptions,
  installDirs: Set<string>,
): Promise<Map<string, string>> {
  const specsByList = new Map<string | null, string[]>();
  const dirsBySpecs = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const suite of suites) {
    const list = suite.packageList;
    if (!specsByList.has(list)) specsByList.set(list, await specsOf(list, suite.name));
    const specs = specsByList.get(list)!;
    const key = JSON.stringify(specs);
    if (!dirsBySpecs.has(key)) {
      const { dir, reused } = await installPackages(specs, config.root, opts.run);
      installDirs.add(dir);
      dirsBySpecs.set(key, dir);
      if (specs.length > 0) {
        opts.log(
          reused
            ? `reused the test packages of ${list} in ${dir}`
            : `installed the test packages of ${list} in ${dir}`,
        );
      }
    }
    dirs.set(suite.name, dirsBySpecs.get(key)!);
  }
  return dirs;
}

/** The specs of a package list; none without a list. A missing list names the skill. */
async function specsOf(list: string | null, skill: string): Promise<string[]> {
  if (list === null) return [];
  return TryAsync.runAsync(() => readPackageList(list)).onFail((error) => {
    if (error instanceof ConfigError && error.message.endsWith('the package list does not exist')) {
      throw new ConfigError(`${error.message} (needed by skill "${skill}")`);
    }
    throw error;
  });
}

/** Where a file of the tests folder is compiled to: the same layout, `.ts` turned into `.js`. */
function compiledPath(runDir: string, testsDir: string, file: string): string {
  return path.join(runDir, 'tests', path.relative(testsDir, file).replace(/\.ts$/, '.js'));
}

/** Transpiles a `.ts` file, copies any other file; a file already written is skipped. */
async function compileFile(
  ts: TypeScript,
  file: string,
  target: string,
  written: Set<string>,
): Promise<void> {
  if (written.has(target)) return;
  written.add(target);
  await mkdir(path.dirname(target), { recursive: true });
  if (file.endsWith('.ts')) {
    await writeFile(target, transpile(ts, await readFile(file, 'utf8'), file, TESTING_URL));
  } else {
    await copyFile(file, target);
  }
}

/**
 * The tests a compiled test file registers; a load error names the source file.
 *
 * @throws ConfigError when the file throws on load or registers no test: a scenario with nothing
 * to score must not pass.
 */
async function listOf(
  config: Config,
  source: string,
  compiled: string,
  cwd: string,
): Promise<string[]> {
  const names = await TryAsync.runAsync(() =>
    listTests({ ...timeouts(config), testFile: compiled, cwd }),
  ).onFail((error) => {
    if (error instanceof ConfigError) {
      throw new ConfigError(error.message.split(compiled).join(source));
    }
    throw error;
  });
  if (names.length === 0) throw new ConfigError(`${source}: registers no tests`);
  return names;
}

function timeouts(config: Config): { testTimeoutMs: number; answerTimeoutMs: number } {
  return {
    testTimeoutMs: config.codeTests.testTimeoutSeconds * 1000,
    answerTimeoutMs: config.codeTests.answerTimeoutSeconds * 1000,
  };
}

function withTests(scenario: Scenario, prepared: Map<string, PreparedScenario>): Scenario {
  const found = prepared.get(scenario.id);
  return found === undefined ? scenario : { ...scenario, tests: found.names };
}

function everyTestFails(
  names: string[],
  message: string,
  infraError: string | null,
): CodeTestResult {
  return { outcomes: names.map((name) => ({ name, pass: false, message })), infraError };
}

/** The result with the compiled test file's path replaced by the source's in every message. */
function withSourceNames(result: CodeTestResult, scenario: PreparedScenario): CodeTestResult {
  const named = (message: string): string => message.split(scenario.compiled).join(scenario.source);
  return {
    outcomes: result.outcomes.map((outcome) => ({ ...outcome, message: named(outcome.message) })),
    infraError: result.infraError === null ? null : named(result.infraError),
  };
}
