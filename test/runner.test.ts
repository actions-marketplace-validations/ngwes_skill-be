import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, type Adapter, type AdapterContext } from '../src/adapters/index.js';
import { contractParagraph } from '../src/code-tests/contract.js';
import type { TestOutcome } from '../src/code-tests/execute.js';
import type { CodeTestResult } from '../src/code-tests/runtime.js';
import { modelLabels, resultsTimestamp, runSkill } from '../src/runner.js';
import {
  ConfigError,
  type AdapterSettings,
  type Config,
  type Scenario,
  type SkillSuite,
} from '../src/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skill-be-runner-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MODEL: AdapterSettings = { adapter: 'fake', id: 'm1' };
const GRADER: AdapterSettings = { adapter: 'fake', id: 'grader' };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    root,
    configPath: path.join(root, 'skill-be.yaml'),
    skills: path.join(root, 'skills'),
    evals: path.join(root, 'evals'),
    models: [MODEL],
    grader: GRADER,
    reps: 1,
    gradings: 1,
    concurrency: 4,
    timeoutSeconds: 120,
    results: path.join(root, 'results'),
    resultFile: path.join(root, 'skill-be.result.json'),
    withSkillTemplate: 'SKILL<{{skill}}>\nTASK<{{task}}>',
    graderPrompt: null,
    gate: { regressionOnCritical: true, blockOnZero: true, blockOnErrors: true },
    checks: { typecheck: false, coverage: false },
    triage: { model: null },
    codeTests: {
      tests: null,
      packages: null,
      packagesBySkill: {},
      testTimeoutSeconds: 10,
      answerTimeoutSeconds: 60,
      allow: [],
    },
    ...overrides,
  };
}

const scenario = (id: string, criteria = ['c1', 'c2']): Scenario => ({
  id,
  critical: false,
  prompt: `Task for ${id}`,
  criteria,
  output: null,
  tests: [],
});

function makeSuite(scenarios: Scenario[] = [scenario('s1')], skillText = 'the skill'): SkillSuite {
  return {
    name: 'demo',
    skillPath: path.join(root, 'skills', 'demo', 'SKILL.md'),
    skillText,
    evalPath: path.join(root, 'evals', 'demo.json'),
    scenarios,
    testFiles: {},
    codeFiles: [],
    packageList: null,
  };
}

const isWithSkill = (prompt: string): boolean => prompt.startsWith('SKILL<');

/** The answer the grader adapter received, taken from the `<answer>` fence. */
function answerIn(prompt: string): string {
  const match = /<answer>\n([\s\S]*)\n<\/answer>/.exec(prompt);
  if (!match?.[1]) throw new Error('no <answer> in the grader prompt');
  return match[1];
}

/** A grader reply with the given verdicts. */
const verdicts = (...values: boolean[]): string =>
  `Reasons.\nVERDICTS:\n${values.map((v, i) => `${i + 1}: ${v ? 'YES' : 'NO'}`).join('\n')}`;

/** A grader that says YES to c1 when the answer contains "good" and NO to c2. */
const keywordGrader: Adapter = async (prompt) => verdicts(answerIn(prompt).includes('good'), false);

type Deps = NonNullable<Parameters<typeof runSkill>[2]>;

function fakes(model: Adapter, grader: Adapter = keywordGrader): Deps {
  return {
    adapterFor: async (settings) => (settings === GRADER ? grader : model),
    log: () => {},
    timestamp: 'T1',
  };
}

/** A scenario with an output contract and code tests, as `prepareCodeTests` fills it. */
const tested = (id: string, criteria: string[], tests: string[]): Scenario => ({
  ...scenario(id, criteria),
  output: { result: 'the value' },
  tests,
});

type RunCall = { skill: string; scenarioId: string; output: string };

/**
 * A fake `codeTests.run` that records its calls and answers with `result(call)`; by default each
 * test of `names` passes when the answer contains "good".
 */
function fakeCodeTests(
  names: string[],
  result: (call: RunCall) => CodeTestResult = ({ output }) => ({
    outcomes: names.map((name) => ({ name, pass: output.includes('good'), message: '' })),
    infraError: null,
  }),
): { run: (skill: string, scenarioId: string, output: string) => Promise<CodeTestResult> } & {
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  return {
    calls,
    run: async (skill, scenarioId, output) => {
      const call = { skill, scenarioId, output };
      calls.push(call);
      return result(call);
    },
  };
}

describe('runSkill prompts', () => {
  it('sends the scenario prompt as the baseline and the filled template as the with-skill arm', async () => {
    const calls: Array<{ prompt: string; ctx: AdapterContext }> = [];
    const model: Adapter = async (prompt, ctx) => {
      calls.push({ prompt, ctx });
      return 'good';
    };

    await runSkill(makeSuite(), makeConfig({ reps: 2 }), fakes(model));

    const prompts = calls.map((call) => call.prompt).sort();
    expect(prompts).toEqual([
      'SKILL<the skill>\nTASK<Task for s1>',
      'SKILL<the skill>\nTASK<Task for s1>',
      'Task for s1',
      'Task for s1',
    ]);
    for (const { ctx } of calls) {
      expect(ctx).toEqual({ settings: MODEL, timeoutMs: 120_000, cwd: root });
    }
  });

  it('substitutes the template in one pass, leaving $ patterns and placeholders in the skill alone', async () => {
    const prompts: string[] = [];
    const model: Adapter = async (prompt) => {
      prompts.push(prompt);
      return 'good';
    };

    await runSkill(makeSuite(undefined, 'uses $& and {{task}}'), makeConfig(), fakes(model));

    expect(prompts.filter(isWithSkill)).toEqual(['SKILL<uses $& and {{task}}>\nTASK<Task for s1>']);
  });

  it('sends the contract paragraph to both arms', async () => {
    const prompts: string[] = [];
    const model: Adapter = async (prompt) => {
      prompts.push(prompt);
      return 'good';
    };
    const contract = { result: 'the value', reason: 'why' };
    const withContract: Scenario = { ...scenario('s1'), output: contract };

    await runSkill(makeSuite([withContract]), makeConfig(), fakes(model));

    const paragraph = contractParagraph(contract);
    expect(prompts.filter(isWithSkill)).toEqual([
      `SKILL<the skill>\nTASK<Task for s1>\n\n${paragraph}`,
    ]);
    expect(prompts.filter((prompt) => !isWithSkill(prompt))).toEqual([
      `Task for s1\n\n${paragraph}`,
    ]);
  });

  it('sends the grader the configured instructions, settings, timeout and cwd', async () => {
    const graderCalls: Array<{ prompt: string; ctx: AdapterContext }> = [];
    const grader: Adapter = async (prompt, ctx) => {
      graderCalls.push({ prompt, ctx });
      return verdicts(true, true);
    };

    await runSkill(
      makeSuite(),
      makeConfig({ graderPrompt: 'Custom judge rules.' }),
      fakes(async () => 'good', grader),
    );

    expect(graderCalls).toHaveLength(2);
    for (const { prompt, ctx } of graderCalls) {
      expect(prompt.startsWith('Custom judge rules.\n\nCriteria:\n1. c1\n2. c2\n')).toBe(true);
      expect(ctx).toEqual({ settings: GRADER, timeoutMs: 120_000, cwd: root });
    }
  });
});

describe('runSkill scores', () => {
  it('computes each percentage over the reps, rounded like Math.round', async () => {
    let baselineCalls = 0;
    // Baseline: 2 of 3 outputs are good; with skill: all 3 are.
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) return 'good';
      baselineCalls++;
      return baselineCalls === 3 ? 'bad' : 'good';
    };

    const run = await runSkill(makeSuite(), makeConfig({ reps: 3 }), fakes(model));

    expect(run.skill).toBe('demo');
    expect(run.errorCount).toBe(0);
    expect(run.scenarios).toHaveLength(1);
    expect(run.scenarios[0]?.models).toEqual([
      {
        model: 'm1',
        criteria: [
          { baselinePct: 67, withSkillPct: 100 },
          { baselinePct: 0, withSkillPct: 0 },
        ],
        notes: [],
        errors: 0,
        outputs: expect.any(Array),
      },
    ]);
  });

  it('counts a failed generation as 0 with an [ERROR] note and an error', async () => {
    const graded: string[] = [];
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) throw new AdapterError('fake (m1) timed out after 120s', 'timeout');
      return 'good';
    };
    const grader: Adapter = async (prompt) => {
      graded.push(answerIn(prompt));
      return keywordGrader(prompt, { settings: GRADER, timeoutMs: 0, cwd: root });
    };

    const run = await runSkill(makeSuite(), makeConfig(), fakes(model, grader));

    expect(run.errorCount).toBe(1);
    expect(run.scenarios[0]?.models[0]).toEqual({
      model: 'm1',
      criteria: [
        { baselinePct: 100, withSkillPct: 0 },
        { baselinePct: 0, withSkillPct: 0 },
      ],
      notes: [
        '[ERROR] rep 1 with skill — generation failed, criteria counted as 0: ' +
          'fake (m1) timed out after 120s',
      ],
      errors: 1,
      outputs: expect.any(Array),
    });
    // The failed output is not graded.
    expect(graded).toEqual(['good']);
  });

  it('counts every grading failing as 0 and an error, with the grader note only once', async () => {
    const model: Adapter = async (prompt) => (isWithSkill(prompt) ? 'skill answer' : 'good');
    const grader: Adapter = async (prompt) =>
      answerIn(prompt) === 'skill answer' ? 'garbage' : verdicts(true, true);

    const run = await runSkill(makeSuite(), makeConfig(), fakes(model, grader));

    expect(run.errorCount).toBe(1);
    expect(run.scenarios[0]?.models[0]).toEqual({
      model: 'm1',
      criteria: [
        { baselinePct: 100, withSkillPct: 0 },
        { baselinePct: 100, withSkillPct: 0 },
      ],
      notes: [
        '[ERROR] rep 1 with skill — every grading failed after retry, criteria counted as 0: ' +
          'unparseable grader answer: "garbage"',
      ],
      errors: 1,
      outputs: expect.any(Array),
    });
  });

  it('puts the rep and arm in grader notes and lists errors before notes', async () => {
    let baselineGradings = 0;
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) throw new Error('boom');
      return 'good';
    };
    // The two gradings of the baseline split 1-1 on criterion 1.
    const grader: Adapter = async () => {
      baselineGradings++;
      return verdicts(baselineGradings === 1, false);
    };

    const run = await runSkill(makeSuite(), makeConfig({ gradings: 2 }), fakes(model, grader));

    expect(run.scenarios[0]?.models[0]?.notes).toEqual([
      '[ERROR] rep 1 with skill — generation failed, criteria counted as 0: boom',
      '[NOTE] rep 1 baseline — criterion 1 tied between 2 gradings, counted as NO',
    ]);
    expect(run.scenarios[0]?.models[0]?.errors).toBe(1);
  });

  it('adds up the errors of every scenario and model', async () => {
    const model: Adapter = async () => {
      throw new Error('down');
    };
    const config = makeConfig({ reps: 2, models: [MODEL, { adapter: 'fake', id: 'm2' }] });

    const run = await runSkill(makeSuite([scenario('s1'), scenario('s2')]), config, fakes(model));

    // 2 scenarios × 2 models × 2 reps × 2 arms.
    expect(run.errorCount).toBe(16);
    expect(run.scenarios.flatMap((s) => s.models.map((m) => m.errors))).toEqual([4, 4, 4, 4]);
  });
});

describe('runSkill files', () => {
  it('writes every output and every raw grader answer under the results directory', async () => {
    let outputs = 0;
    const model: Adapter = async (prompt) => {
      outputs++;
      return `${isWithSkill(prompt) ? 'skill' : 'base'} output ${outputs} good`;
    };
    let gradings = 0;
    const grader: Adapter = async () => {
      gradings++;
      return `grading ${gradings}\n${verdicts(true, false)}`;
    };

    await runSkill(makeSuite(), makeConfig({ reps: 2, gradings: 2 }), fakes(model, grader));

    const dir = path.join(root, 'results', 'T1', 'demo', 's1', 'm1');
    expect((await readdir(dir)).sort()).toEqual([
      'rep-1-baseline.grading-1.md',
      'rep-1-baseline.grading-2.md',
      'rep-1-baseline.md',
      'rep-1-with-skill.grading-1.md',
      'rep-1-with-skill.grading-2.md',
      'rep-1-with-skill.md',
      'rep-2-baseline.grading-1.md',
      'rep-2-baseline.grading-2.md',
      'rep-2-baseline.md',
      'rep-2-with-skill.grading-1.md',
      'rep-2-with-skill.grading-2.md',
      'rep-2-with-skill.md',
    ]);
    expect(await readFile(path.join(dir, 'rep-1-baseline.md'), 'utf8')).toMatch(
      /^base output \d good$/,
    );
    expect(await readFile(path.join(dir, 'rep-2-with-skill.md'), 'utf8')).toMatch(
      /^skill output \d good$/,
    );
    expect(await readFile(path.join(dir, 'rep-1-baseline.grading-2.md'), 'utf8')).toMatch(
      /^grading \d\nReasons\.\nVERDICTS:\n1: YES\n2: NO$/,
    );
  });

  it('keeps each output and its grader answers in the result, as the files hold them', async () => {
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt) && prompt.includes('s2')) throw new Error('down');
      return `${isWithSkill(prompt) ? 'skill' : 'base'} output good`;
    };
    let gradings = 0;
    const grader: Adapter = async () => `grading ${++gradings}\n${verdicts(true, false)}`;

    const run = await runSkill(
      makeSuite([scenario('s1'), scenario('s2')]),
      makeConfig({ reps: 2, gradings: 2 }),
      fakes(model, grader),
    );

    const [s1, s2] = run.scenarios.map((result) => result.models[0]?.outputs ?? []);
    expect(s1).toHaveLength(2);
    const dir = path.join(root, 'results', 'T1', 'demo', 's1', 'm1');
    for (const [r, rep] of (s1 ?? []).entries()) {
      for (const arm of ['baseline', 'with-skill'] as const) {
        const file = path.join(dir, `rep-${r + 1}-${arm}`);
        expect(rep[arm].output).toBe(await readFile(`${file}.md`, 'utf8'));
        expect(rep[arm].tests).toEqual([]);
        expect(rep[arm].gradings).toHaveLength(2);
        for (const [k, answer] of rep[arm].gradings.entries()) {
          expect(answer).toBe(await readFile(`${file}.grading-${k + 1}.md`, 'utf8'));
        }
      }
    }
    // A failed output keeps its error text and has no grader answers.
    expect(s2?.map((rep) => rep['with-skill'])).toEqual([
      { output: '[ERROR: down]\n', gradings: [], tests: [] },
      { output: '[ERROR: down]\n', gradings: [], tests: [] },
    ]);
  });

  it('writes the error in place of an output that failed, and no grading files for it', async () => {
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) throw new Error('exit 1:\n  bad\tthing');
      return 'good';
    };

    await runSkill(makeSuite(), makeConfig(), fakes(model));

    const dir = path.join(root, 'results', 'T1', 'demo', 's1', 'm1');
    expect((await readdir(dir)).sort()).toEqual([
      'rep-1-baseline.grading-1.md',
      'rep-1-baseline.md',
      'rep-1-with-skill.md',
    ]);
    expect(await readFile(path.join(dir, 'rep-1-with-skill.md'), 'utf8')).toBe(
      '[ERROR: exit 1: bad thing]\n',
    );
  });

  it('defaults the timestamp to a filesystem-safe ISO time', async () => {
    const { timestamp: _, ...deps } = fakes(async () => 'good');

    await runSkill(makeSuite(), makeConfig(), deps);

    const [stamp, ...others] = await readdir(path.join(root, 'results'));
    expect(others).toEqual([]);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it('makes scenario and model directory names safe on every platform', async () => {
    const models = [
      { adapter: 'a', id: 'same' },
      { adapter: 'b', id: 'same' },
      { adapter: 'c', id: 'openai/gpt' },
    ];

    const run = await runSkill(
      makeSuite([scenario('a:b'), scenario('a_b')]),
      makeConfig({ models }),
      fakes(async () => 'good'),
    );

    const labels = ['a:same', 'b:same', 'openai/gpt'];
    expect(run.scenarios[0]?.models.map((m) => m.model)).toEqual(labels);
    const demo = path.join(root, 'results', 'T1', 'demo');
    expect((await readdir(demo)).sort()).toEqual(['a_b', 'a_b-2']);
    const dirs = ['a_same', 'b_same', 'openai_gpt'];
    expect((await readdir(path.join(demo, 'a_b'))).sort()).toEqual(dirs);
    expect((await readdir(path.join(demo, 'a_b-2'))).sort()).toEqual(dirs);
  });
});

describe('runSkill code tests', () => {
  const TESTS = ['responds 201', 'rejects a bad body'];
  const outputDir = (): string => path.join(root, 'results', 'T1', 'demo', 's1', 'm1');
  const allPass = (names: string[]): TestOutcome[] =>
    names.map((name) => ({ name, pass: true, message: '' }));
  const allFail = (names: string[], message: string): TestOutcome[] =>
    names.map((name) => ({ name, pass: false, message }));

  it('scores each test as a line after the criteria', async () => {
    const model: Adapter = async (prompt) => (isWithSkill(prompt) ? 'good code' : 'bad code');
    const codeTests = fakeCodeTests(TESTS, ({ output }) => ({
      outcomes: [
        { name: 'responds 201', pass: true, message: '' },
        { name: 'rejects a bad body', pass: output.includes('good'), message: '' },
      ],
      infraError: null,
    }));

    const run = await runSkill(
      makeSuite([tested('s1', ['c1', 'c2'], TESTS)]),
      makeConfig({ reps: 2 }),
      { ...fakes(model), codeTests },
    );

    expect(run.errorCount).toBe(0);
    expect(run.scenarios[0]?.models[0]).toEqual({
      model: 'm1',
      criteria: [
        { baselinePct: 0, withSkillPct: 100 },
        { baselinePct: 0, withSkillPct: 0 },
        { baselinePct: 100, withSkillPct: 100 },
        { baselinePct: 0, withSkillPct: 100 },
      ],
      notes: [],
      errors: 0,
      outputs: expect.any(Array),
    });
    const calls = codeTests.calls.map((call) => [call.skill, call.scenarioId, call.output]);
    expect(calls.sort()).toEqual([
      ['demo', 's1', 'bad code'],
      ['demo', 's1', 'bad code'],
      ['demo', 's1', 'good code'],
      ['demo', 's1', 'good code'],
    ]);
  });

  it('runs the code tests only for the scenarios that have tests', async () => {
    const codeTests = fakeCodeTests(['t1']);

    const run = await runSkill(
      makeSuite([scenario('s1'), tested('s2', ['c1', 'c2'], ['t1'])]),
      makeConfig(),
      { ...fakes(async () => 'good'), codeTests },
    );

    expect(codeTests.calls.map((call) => call.scenarioId)).toEqual(['s2', 's2']);
    expect(run.scenarios.map((s) => s.models[0]?.criteria.length)).toEqual([2, 3]);
  });

  it('skips the judge for a scenario without criteria', async () => {
    let graderCalls = 0;
    const grader: Adapter = async () => {
      graderCalls++;
      return verdicts();
    };
    const model: Adapter = async (prompt) => (isWithSkill(prompt) ? 'good' : 'bad');

    const run = await runSkill(makeSuite([tested('s1', [], ['t1'])]), makeConfig(), {
      ...fakes(model, grader),
      codeTests: fakeCodeTests(['t1']),
    });

    expect(graderCalls).toBe(0);
    expect(run.errorCount).toBe(0);
    const result = run.scenarios[0]?.models[0];
    expect(result?.criteria).toEqual([{ baselinePct: 0, withSkillPct: 100 }]);
    expect(result?.notes).toEqual([]);
    expect(result?.outputs[0]?.baseline.gradings).toEqual([]);
    expect((await readdir(outputDir())).sort()).toEqual([
      'rep-1-baseline.md',
      'rep-1-baseline.tests.json',
      'rep-1-with-skill.md',
      'rep-1-with-skill.tests.json',
    ]);
  });

  it('counts an infra error as an error and the test lines as 0', async () => {
    const model: Adapter = async (prompt) => (isWithSkill(prompt) ? 'good skill' : 'good base');
    const codeTests = fakeCodeTests(TESTS, ({ output }) =>
      output.includes('skill')
        ? { outcomes: allFail(TESTS, 'npm is gone'), infraError: 'npm is gone' }
        : { outcomes: allPass(TESTS), infraError: null },
    );

    const run = await runSkill(makeSuite([tested('s1', ['c1', 'c2'], TESTS)]), makeConfig(), {
      ...fakes(model),
      codeTests,
    });

    expect(run.errorCount).toBe(1);
    expect(run.scenarios[0]?.models[0]).toEqual({
      model: 'm1',
      criteria: [
        { baselinePct: 100, withSkillPct: 100 },
        { baselinePct: 0, withSkillPct: 0 },
        { baselinePct: 100, withSkillPct: 0 },
        { baselinePct: 100, withSkillPct: 0 },
      ],
      notes: ['[ERROR] rep 1 with skill — code tests could not run: npm is gone'],
      errors: 1,
      outputs: expect.any(Array),
    });
  });

  it('does not count a failing test as an error', async () => {
    const codeTests = fakeCodeTests(TESTS, () => ({
      outcomes: allFail(TESTS, 'expected 201, got 500'),
      infraError: null,
    }));

    const run = await runSkill(makeSuite([tested('s1', [], TESTS)]), makeConfig(), {
      ...fakes(async () => 'good'),
      codeTests,
    });

    expect(run.errorCount).toBe(0);
    expect(run.scenarios[0]?.models[0]).toEqual({
      model: 'm1',
      criteria: [
        { baselinePct: 0, withSkillPct: 0 },
        { baselinePct: 0, withSkillPct: 0 },
      ],
      notes: [],
      errors: 0,
      outputs: expect.any(Array),
    });
  });

  it('still runs the tests when every grading fails, and counts one error', async () => {
    const codeTests = fakeCodeTests(TESTS, () => ({ outcomes: allPass(TESTS), infraError: null }));

    const run = await runSkill(makeSuite([tested('s1', ['c1'], TESTS)]), makeConfig(), {
      ...fakes(
        async (prompt) => (isWithSkill(prompt) ? 'skill answer' : 'good'),
        async (prompt) => (answerIn(prompt) === 'skill answer' ? 'garbage' : verdicts(true)),
      ),
      codeTests,
    });

    expect(run.errorCount).toBe(1);
    expect(codeTests.calls).toHaveLength(2);
    expect(run.scenarios[0]?.models[0]?.criteria).toEqual([
      { baselinePct: 100, withSkillPct: 0 },
      { baselinePct: 100, withSkillPct: 100 },
      { baselinePct: 100, withSkillPct: 100 },
    ]);
  });

  it('counts a grading failure and an infra error on one output as two errors', async () => {
    const codeTests = fakeCodeTests(TESTS, () => ({
      outcomes: allFail(TESTS, 'no npm'),
      infraError: 'no npm',
    }));

    const run = await runSkill(makeSuite([tested('s1', ['c1'], TESTS)]), makeConfig(), {
      ...fakes(
        async (prompt) => (isWithSkill(prompt) ? 'skill answer' : 'good'),
        async (prompt) => (answerIn(prompt) === 'skill answer' ? 'garbage' : verdicts(true)),
      ),
      codeTests,
    });

    // The baseline's infra error, then the with-skill output's grading failure and infra error.
    expect(run.errorCount).toBe(3);
    expect(run.scenarios[0]?.models[0]?.notes).toEqual([
      '[ERROR] rep 1 baseline — code tests could not run: no npm',
      '[ERROR] rep 1 with skill — every grading failed after retry, criteria counted as 0: ' +
        'unparseable grader answer: "garbage"',
      '[ERROR] rep 1 with skill — code tests could not run: no npm',
    ]);
  });

  it('runs neither the judge nor the tests for an output that could not be generated', async () => {
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) throw new Error('down');
      return 'good';
    };
    const codeTests = fakeCodeTests(TESTS);

    const run = await runSkill(makeSuite([tested('s1', ['c1', 'c2'], TESTS)]), makeConfig(), {
      ...fakes(model),
      codeTests,
    });

    expect(codeTests.calls.map((call) => call.output)).toEqual(['good']);
    expect(run.errorCount).toBe(1);
    const result = run.scenarios[0]?.models[0];
    expect(result?.criteria).toEqual([
      { baselinePct: 100, withSkillPct: 0 },
      { baselinePct: 0, withSkillPct: 0 },
      { baselinePct: 100, withSkillPct: 0 },
      { baselinePct: 100, withSkillPct: 0 },
    ]);
    expect(result?.notes).toEqual([
      '[ERROR] rep 1 with skill — generation failed, criteria counted as 0: down',
    ]);
    expect(result?.outputs[0]?.['with-skill']).toEqual({
      output: '[ERROR: down]\n',
      gradings: [],
      tests: [],
    });
    expect((await readdir(outputDir())).sort()).toEqual([
      'rep-1-baseline.grading-1.md',
      'rep-1-baseline.md',
      'rep-1-baseline.tests.json',
      'rep-1-with-skill.md',
    ]);
  });

  it('writes the test outcomes beside the output', async () => {
    const outcomes: TestOutcome[] = [
      { name: 'responds 201', pass: true, message: '' },
      { name: 'rejects a bad body', pass: false, message: 'expected 400, got 200' },
    ];
    const codeTests = fakeCodeTests(TESTS, () => ({ outcomes, infraError: null }));

    const run = await runSkill(makeSuite([tested('s1', ['c1', 'c2'], TESTS)]), makeConfig(), {
      ...fakes(async () => 'good'),
      codeTests,
    });

    for (const arm of ['baseline', 'with-skill'] as const) {
      expect(await readFile(path.join(outputDir(), `rep-1-${arm}.tests.json`), 'utf8')).toBe(
        `${JSON.stringify(outcomes, null, 2)}\n`,
      );
      expect(run.scenarios[0]?.models[0]?.outputs[0]?.[arm].tests).toEqual(outcomes);
    }
  });

  it('logs the tests passed beside the YES count', async () => {
    const lines: string[] = [];
    const codeTests = fakeCodeTests(TESTS, ({ output }) =>
      output === 'infra'
        ? { outcomes: allFail(TESTS, 'no npm'), infraError: 'no npm' }
        : {
            outcomes: [
              { name: 'responds 201', pass: true, message: '' },
              { name: 'rejects a bad body', pass: false, message: 'x' },
            ],
            infraError: null,
          },
    );

    const model: Adapter = async (prompt) =>
      isWithSkill(prompt) && prompt.includes('s2') ? 'infra' : 'good';

    await runSkill(
      makeSuite([tested('s1', ['c1', 'c2'], TESTS), tested('s2', [], TESTS)]),
      makeConfig(),
      { ...fakes(model), codeTests, log: (line) => lines.push(line) },
    );

    // The time each output took, as `(Ns)`.
    const untimed = lines.map((line) => line.replace(/ \(\d+\.\ds\)$/, ' (Ns)'));
    expect(untimed).toContain('  [s1] m1 rep 1/1 baseline: 1/2 YES, 1/2 tests passed (Ns)');
    expect(untimed).toContain('  [s2] m1 rep 1/1 baseline: 1/2 tests passed (Ns)');
    expect(untimed).toContain('  [s2] m1 rep 1/1 with skill: tests could not run (Ns)');
  });

  it('runs the tests through the limiter of the model calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const tracked = async <T>(ms: number, value: T): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight--;
      return value;
    };
    const codeTests = {
      run: (): Promise<CodeTestResult> =>
        tracked(20, { outcomes: allPass(['t1']), infraError: null }),
    };

    await runSkill(
      makeSuite([tested('s1', ['c1'], ['t1']), tested('s2', ['c1'], ['t1'])]),
      makeConfig({ reps: 3, concurrency: 2 }),
      {
        ...fakes(
          () => tracked(1, 'good'),
          () => tracked(1, verdicts(true)),
        ),
        codeTests,
      },
    );

    expect(peak).toBe(2);
  });

  it('throws before any model call when a scenario has tests and no codeTests', async () => {
    let modelCalls = 0;
    const model: Adapter = async () => {
      modelCalls++;
      return 'good';
    };
    const suite = makeSuite([scenario('s0'), tested('s1', ['c1'], ['t1'])]);

    await expect(runSkill(suite, makeConfig(), fakes(model))).rejects.toThrow('scenario "s1" of skill "demo" has code tests, but no codeTests were given');
    expect(modelCalls).toBe(0);
  });
});

describe('runSkill config errors', () => {
  /** Lets calls still in flight after the rejection finish before the checks and cleanup. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  const outputDir = (): string => path.join(root, 'results', 'T1', 'demo', 's1', 'm1');

  it('stops the run on a ConfigError from a model adapter instead of counting an error', async () => {
    const error = new ConfigError('the pi-cli adapter needs a non-empty "provider" setting');
    const lines: string[] = [];
    const model: Adapter = async () => {
      throw error;
    };

    await expect(
      runSkill(makeSuite(), makeConfig(), { ...fakes(model), log: (l) => lines.push(l) }),
    ).rejects.toBe(error);
    await settle();

    expect(lines.filter((l) => l.includes('generation failed'))).toEqual([]);
    expect(await readdir(outputDir())).toEqual([]);
  });

  it('stops the run on a ConfigError from the grader adapter, without a retry', async () => {
    const error = new ConfigError('the opencode-cli adapter needs a non-empty "provider" setting');
    const lines: string[] = [];
    let graderCalls = 0;
    const grader: Adapter = async () => {
      graderCalls++;
      throw error;
    };

    await expect(
      runSkill(makeSuite(), makeConfig(), {
        ...fakes(async () => 'good', grader),
        log: (l) => lines.push(l),
      }),
    ).rejects.toBe(error);
    await settle();

    // One call per output (baseline and with skill), none retried.
    expect(graderCalls).toBe(2);
    expect(lines.filter((l) => /grading FAILED|YES/.test(l))).toEqual([]);
    expect((await readdir(outputDir())).sort()).toEqual([
      'rep-1-baseline.md',
      'rep-1-with-skill.md',
    ]);
  });

  it('stops the run when the model CLI cannot start, instead of counting an error', async () => {
    const error = new AdapterError('command (no-such-cli) could not start: ENOENT', 'spawn');
    const lines: string[] = [];
    const model: Adapter = async () => {
      throw error;
    };

    await expect(
      runSkill(makeSuite(), makeConfig(), { ...fakes(model), log: (l) => lines.push(l) }),
    ).rejects.toBe(error);
    await settle();

    expect(lines.filter((l) => l.includes('generation failed'))).toEqual([]);
    expect(await readdir(outputDir())).toEqual([]);
  });

  it('stops the run when the grader CLI cannot start, without a retry', async () => {
    const error = new AdapterError('command (no-such-cli) could not start: ENOENT', 'spawn');
    let graderCalls = 0;
    const grader: Adapter = async () => {
      graderCalls++;
      throw error;
    };

    await expect(
      runSkill(makeSuite(), makeConfig(), fakes(async () => 'good', grader)),
    ).rejects.toBe(error);
    await settle();

    expect(graderCalls).toBe(2);
  });
});

describe('runSkill concurrency and order', () => {
  it('keeps at most `concurrency` generation and grading calls in flight, together', async () => {
    let inFlight = 0;
    let peak = 0;
    const track =
      (answer: (prompt: string) => string): Adapter =>
      async (prompt) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return answer(prompt);
      };

    await runSkill(
      makeSuite([scenario('s1'), scenario('s2')]),
      makeConfig({ reps: 3, gradings: 3, concurrency: 2 }),
      fakes(
        track(() => 'good'),
        track(() => verdicts(true, false)),
      ),
    );

    expect(peak).toBe(2);
  });

  it('returns scenarios and models in config and eval file order, whatever finishes first', async () => {
    // Earlier scenarios and models answer later.
    const delays: Record<string, number> = { s1: 30, s2: 15, s3: 0 };
    const model: Adapter = async (prompt, { settings }) => {
      const id = /s\d/.exec(prompt)?.[0] ?? '';
      const delay = (delays[id] ?? 0) + (settings.id === 'm1' ? 10 : 0);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return 'good';
    };
    const config = makeConfig({ models: [MODEL, { adapter: 'fake', id: 'm2' }] });

    const run = await runSkill(
      makeSuite([scenario('s1'), scenario('s2'), scenario('s3')]),
      config,
      fakes(model),
    );

    expect(run.scenarios.map((s) => s.scenario.id)).toEqual(['s1', 's2', 's3']);
    for (const result of run.scenarios) {
      expect(result.models.map((m) => m.model)).toEqual(['m1', 'm2']);
    }
  });
});

describe('runSkill progress and timing', () => {
  it('logs progress lines like run-benchmark.mjs', async () => {
    const lines: string[] = [];
    const model: Adapter = async (prompt) => {
      if (isWithSkill(prompt)) throw new Error('boom');
      return 'good';
    };

    await runSkill(makeSuite(), makeConfig(), {
      ...fakes(model),
      log: (line) => lines.push(line),
    });

    expect(lines[0]).toBe('demo: 1 scenarios × 1 model(s) × 1 reps, concurrency 4');
    expect(lines).toContain('  [s1] m1 rep 1/1 with skill: generation failed — boom');
    expect(
      lines.some((l) => /^ {2}\[s1\] m1 rep 1\/1 baseline: 1\/2 YES \(\d+\.\ds\)$/.test(l)),
    ).toBe(true);
    expect(
      lines.some((l) => /^ {2}\[s1\] m1 rep 1\/1 done \(1\/1 reps, \d+\.\ds elapsed\)$/.test(l)),
    ).toBe(true);
    expect(lines.at(-1)).toMatch(/^demo: finished in \d+\.\ds, 1 error\(s\)$/);
  });

  it('logs "grading FAILED" when every grading fails', async () => {
    const lines: string[] = [];

    await runSkill(makeSuite(), makeConfig(), {
      ...fakes(async () => 'good', async () => 'garbage'),
      log: (line) => lines.push(line),
    });

    expect(lines.some((l) => /^ {2}\[s1\] m1 rep 1\/1 baseline: grading FAILED \(/.test(l))).toBe(
      true,
    );
  });

  it('records when the run started and how long it took', async () => {
    const before = Date.now();
    const run = await runSkill(makeSuite(), makeConfig(), fakes(async () => 'good'));

    expect(Date.parse(run.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves the adapters through resolveAdapter with the config root by default', async () => {
    const config = makeConfig({
      models: [{ adapter: './adapter.mjs', id: 'm1' }],
      grader: { adapter: './adapter.mjs', id: 'g' },
    });

    await expect(runSkill(makeSuite(), config, { log: () => {} })).rejects.toThrow(
      `adapter module not found: ${path.join(root, 'adapter.mjs')}`,
    );
  });
});

describe('modelLabels', () => {
  it('uses the id, or adapter:id when ids repeat, and numbers entries that are still the same', () => {
    expect(
      modelLabels([
        { adapter: 'claude-cli', id: 'sonnet' },
        { adapter: 'pi-cli', id: 'gpt' },
        { adapter: 'opencode-cli', id: 'gpt' },
        { adapter: 'pi-cli', id: 'kimi' },
        { adapter: 'pi-cli', id: 'kimi' },
      ]),
    ).toEqual(['sonnet', 'pi-cli:gpt', 'opencode-cli:gpt', 'pi-cli:kimi#1', 'pi-cli:kimi#2']);
  });
});

describe('resultsTimestamp', () => {
  it('is the ISO time without colons or dots', () => {
    expect(resultsTimestamp(new Date('2026-10-31T09:05:03.042Z'))).toBe('2026-10-31T09-05-03-042Z');
  });
});
