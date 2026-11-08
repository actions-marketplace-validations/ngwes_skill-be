/**
 * Triage: a closer look at the criteria and code tests that failed in the latest run. For each
 * one it generates fresh with-skill samples, grades them with the grader's reasons kept (or runs
 * them against the code tests, with the failure messages kept), and asks a model to propose one
 * of four classifications, for a human to confirm. It never blocks anything.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Either, Option, Try, TryAsync, foldAsync } from '@ngwes/mini-fp';
import { isConfigProblem, resolveAdapter, type Adapter } from './adapters/index.js';
import { valueOrThrow } from './checked.js';
import { armPrompts, contractParagraph } from './code-tests/contract.js';
import type { CodeTests } from './code-tests/runtime.js';
import { gradeOutput, graderReasons, parseVerdicts } from './grader.js';
import { createLimiter } from './limiter.js';
import { cell, type RunSummary, type SkillSummary } from './report.js';
import { modelLabels, resultsTimestamp, type CriterionScore } from './runner.js';
import { TEST_LINE_PREFIX } from './scored-lines.js';
import type { AdapterSettings, Config, Scenario, SkillSuite } from './types.js';

/** The categories a failing judge criterion is classified into. */
export const TRIAGE_CATEGORIES = [
  'skill gap',
  'eval too strict',
  'grader error',
  'model choice',
] as const;

/** The categories a failing code test is classified into: `test error` replaces `grader error`. */
export const TEST_TRIAGE_CATEGORIES = [
  'skill gap',
  'eval too strict',
  'test error',
  'model choice',
] as const;

export type TriageCategory =
  | (typeof TRIAGE_CATEGORIES)[number]
  | (typeof TEST_TRIAGE_CATEGORIES)[number];

/** The definitions the triage model classifies by, from the design. */
const DEFINITIONS: Record<TriageCategory, string> = {
  'skill gap': "the skill doesn't teach it clearly enough",
  'eval too strict':
    'the answer is correct and idiomatic, but the criterion demands one form or something the ' +
    "prompt didn't ask for",
  'grader error': 'the answer satisfies the criterion and the grader still says NO',
  'test error':
    'the test, not the answer, is wrong (too strict, or it checks something the task did not ' +
    'ask for)',
  'model choice': 'the skill is clear and the model picks another reasonable approach',
};

export type TriageItem = {
  skill: string;
  scenario: string;
  /** The criterion's text, or the code test's scored line, `[test] <name>`. */
  criterion: string;
  /** The label of the model under test whose samples were triaged, as in the run. */
  model: string;
  /** `unclassified` when no sample came back, or the classification failed or was unparseable. */
  proposed: TriageCategory | 'unclassified';
  /** The triage model's one-line reason, or why the failure is unclassified. */
  reason: string;
  /** The triage model's reply, kept when it could not be parsed. */
  rawAnswer?: string;
};

export type TriageDeps = {
  /** Resolves an entry's adapter; `resolveAdapter` against the config root by default. */
  adapterFor?: (settings: AdapterSettings) => Promise<Adapter>;
  /** Receives one progress line at a time; stderr by default. */
  log?: (line: string) => void;
  /** Names the report, `triage-<timestamp>.md`; a new `resultsTimestamp()` by default. */
  timestamp?: string;
  /**
   * Prepares the code tests of the given suites (see `prepareCodeTests`); required when a code
   * test is to be triaged. Called once, with the suites that have one, before any model call, and
   * not at all when only criteria are triaged. The caller disposes of what it returns.
   */
  prepareCodeTests?: (suites: SkillSuite[]) => Promise<TestRunner>;
};

/** What triage uses of the prepared code tests. */
type TestRunner = Pick<CodeTests, 'suites' | 'run'>;

export type TriageOptions = {
  /** Also triage every criterion or code test that scored under this percentage with the skill. */
  below?: number;
  /** Fresh with-skill samples per failing criterion; 2 by default. */
  samples?: number;
  deps?: TriageDeps;
};

/** The failing line of a target: a judge criterion, or a code test. */
type Line = { criterion: number } | { test: string };

/** One failure to triage: a criterion or a code test of a scenario, on one model under test. */
type Target = {
  suite: SkillSuite;
  /** The scenario of the current eval file; for a code test, with its `tests` filled. */
  scenario: Scenario;
  /** The criterion by its index in the current eval file, or the code test by its name. */
  line: Line;
  label: string;
  settings: AdapterSettings;
  /** Why it is triaged: the blocks it caused and whether it scored under `below`. */
  causes: string[];
  score: CriterionScore;
};

/** One graded grading of a sample: its verdict on the triaged criterion and its reasons. */
type Grading = { verdict: 0 | 1 | null; reasons: string };

/**
 * A sample: graded (a criterion), run against the code tests (a code test: the verdict is that
 * test's outcome, `testMessage` its message, or why it has no verdict), or not generated.
 */
type Sample =
  | { output: string; verdict: 0 | 1 | null; gradings: Grading[] }
  | { output: string; verdict: 0 | 1 | null; testMessage: string }
  | { error: string };

type Triaged = { target: Target; samples: Sample[]; item: TriageItem };

/** A results subdirectory named by `resultsTimestamp()`, such as `2026-10-31T09-05-03-042Z`. */
const RUN_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Triages the failing criteria and code tests of the given skills in the latest run: the newest
 * results directory with a `summary.json`. A scored line (a criterion, or a code test) fails when
 * it caused a `zero` block (triaged on every model under test) or a `regression` block (on its
 * model), and, with `below`, when it scored under `below`% with the skill on a model. `error`
 * blocks name no line: they are listed in the report as not triaged, and so is a failure whose
 * scenario, criterion, code test or model the current eval file, tests or config no longer has.
 * The code tests are prepared (`deps.prepareCodeTests`) only when a code test fails.
 *
 * For each failure: `samples` with-skill generations by that model, with the scenario's output
 * contract and never its tests. For a criterion, each sample is graded `gradings` times with the
 * grader prompt (which asks for a reason per criterion); for a code test, each runs against the
 * scenario's tests, without the grader. Then one classification by `triage.model`, else by that
 * failure's own model under test (the one whose output failed, not the grader, since grader and
 * test errors are among the categories). Every call and test run goes through one limiter of
 * `concurrency`. A failed call is recorded in the report; a config problem (a `ConfigError`, or a
 * CLI that cannot start: see `isConfigProblem`) rejects `triage`.
 *
 * Writes `<run dir>/triage-<timestamp>.md` with the code, the grader reasons or test messages, and
 * the proposals.
 *
 * @throws ConfigError when there is no run with a summary, or the summary cannot be read.
 * @throws Error, before any model call, when a code test fails and `deps.prepareCodeTests` is not
 * given.
 */
export async function triage(
  config: Config,
  suites: SkillSuite[],
  opts: TriageOptions = {},
): Promise<{ reportPath: string; items: TriageItem[] }> {
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const adapterFor =
    deps.adapterFor ??
    ((settings: AdapterSettings) => resolveAdapter(settings.adapter, config.root));
  const sampleCount = opts.samples ?? 2;
  const classifierOf = (target: Target): AdapterSettings =>
    Option.from(config.triage.model).orElse(target.settings);

  const run = await latestRun(config.results);
  const { selection, codeTests } = await withCodeTests(
    selectTargets(run.summary, suites, config.models, opts.below),
    deps.prepareCodeTests,
  );
  const targets = selection.flatMap((entry) => entry.match((target) => [target], () => []));
  const notes = selection.flatMap((entry) => entry.match(() => [], (note) => [note]));
  const reportPath = path.join(run.dir, `triage-${deps.timestamp ?? resultsTimestamp()}.md`);
  log(`triage: ${targets.length} failure(s) to triage in run ${run.name}`);

  // Resolve every adapter before the first call, so a config error stops triage at once.
  const adapters = new Map<AdapterSettings, Adapter>();
  if (targets.length > 0) {
    const graded = targets.some((t) => 'criterion' in t.line);
    const needed = new Set([
      ...targets.flatMap((t) => [t.settings, classifierOf(t)]),
      ...(graded ? [config.grader] : []),
    ]);
    for (const settings of needed) adapters.set(settings, await adapterFor(settings));
  }

  const limit = createLimiter(config.concurrency);
  const timeoutMs = config.timeoutSeconds * 1000;
  const call = (settings: AdapterSettings, prompt: string): Promise<string> =>
    limit(() =>
      (adapters.get(settings) as Adapter)(prompt, { settings, timeoutMs, cwd: config.root }),
    );
  const grade = (prompt: string): Promise<string> => call(config.grader, prompt);

  function sample(target: Target, prompt: string): Promise<Sample> {
    const { line } = target;
    return TryAsync.runAsync(() => call(target.settings, prompt)).match<Sample>(
      (output) =>
        'test' in line
          ? testSample(target, line.test, output)
          : gradedSample(target, line.criterion, output),
      (error) => {
        if (isConfigProblem(error)) throw error;
        return { error: messageOf(error) };
      },
    );
  }

  /** Grades one sample `gradings` times: its verdict and reasons on the criterion. */
  async function gradedSample(target: Target, criterion: number, output: string): Promise<Sample> {
    const { criteria } = target.scenario;
    const graded = await gradeOutput(
      criteria,
      output,
      grade,
      config.gradings,
      config.graderPrompt ?? undefined,
    );
    return {
      output,
      verdict: graded.verdicts?.[criterion] ?? null,
      gradings: graded.rawAnswers.map((answer) => ({
        verdict: parseVerdicts(answer, criteria.length)?.[criterion] ?? null,
        reasons: graderReasons(answer),
      })),
    };
  }

  /** Runs one sample against the scenario's tests: its verdict is the outcome of the test. */
  async function testSample(target: Target, test: string, output: string): Promise<Sample> {
    // `withCodeTests` prepared the code tests, since a code test is triaged.
    const { outcomes, infraError } = await limit(() =>
      (codeTests as TestRunner).run(target.suite.name, target.scenario.id, output),
    );
    if (infraError !== null) return { output, verdict: null, testMessage: infraError };
    return Option.from(outcomes.find((outcome) => outcome.name === test)).match<Sample>(
      (outcome) => ({ output, verdict: outcome.pass ? 1 : 0, testMessage: outcome.message }),
      () => ({ output, verdict: null, testMessage: `the test "${test}" reported no outcome` }),
    );
  }

  /** The classification prompt of a target; a code test's names its test file's source. */
  async function promptFor(target: Target, samples: Sample[]): Promise<string> {
    const { line, suite, scenario } = target;
    if (!('test' in line)) return classificationPrompt(target, line.criterion, samples);
    const source = await readFile(suite.testFiles[scenario.id] as string, 'utf8');
    return testClassificationPrompt(target, line.test, samples, source);
  }

  async function classify(target: Target, samples: Sample[]): Promise<TriageItem> {
    const item = {
      skill: target.suite.name,
      scenario: target.scenario.id,
      criterion: lineText(target),
      model: target.label,
    };
    const errors = samples.flatMap((s) => ('error' in s ? [s.error] : []));
    if (errors.length === samples.length) {
      return {
        ...item,
        proposed: 'unclassified',
        reason: `no sample could be generated: ${errors[0]}`,
      };
    }
    const prompt = await promptFor(target, samples);
    return TryAsync.runAsync(() => call(classifierOf(target), prompt)).match<TriageItem>(
      (answer) =>
        Option.from(parseClassification(answer, categoriesOf(target))).match<TriageItem>(
          (parsed) => ({ ...item, ...parsed }),
          () => ({
            ...item,
            proposed: 'unclassified',
            reason: 'the classification could not be parsed',
            rawAnswer: answer,
          }),
        ),
      (error) => {
        if (isConfigProblem(error)) throw error;
        return {
          ...item,
          proposed: 'unclassified',
          reason: `the classification call failed: ${messageOf(error)}`,
        };
      },
    );
  }

  const triaged: Triaged[] = await Promise.all(
    targets.map(async (target) => {
      // With the output contract, as the with-skill arm of the run had it.
      const prompt = armPrompts(
        config.withSkillTemplate,
        target.suite.skillText,
        target.scenario,
      ).withSkill;
      const samples = await Promise.all(
        Array.from({ length: sampleCount }, () => sample(target, prompt)),
      );
      const item = await classify(target, samples);
      log(`  [${item.scenario}] ${item.model} "${item.criterion}": ${item.proposed}`);
      return { target, samples, item };
    }),
  );

  await writeFile(
    reportPath,
    renderTriage(triaged, notes, {
      run: run.name,
      samples: sampleCount,
      gradings: config.gradings,
      grader: config.grader,
      classifier: config.triage.model,
    }),
  );
  return { reportPath, items: triaged.map((t) => t.item) };
}

/**
 * Reads the classification from the triage model's reply: the last `CLASSIFICATION:` line, with
 * a `REASON:` line after it (the last one). Markdown around a label or a value is ignored
 * (`**CLASSIFICATION:** *Grader Error*`, `- Reason: ...`, quotes, a trailing period), as are
 * case and hyphens in the category, and words after it (`grader error — it calls map`). Returns
 * `null` unless the category is one of `categories` (a criterion's by default;
 * {@link TEST_TRIAGE_CATEGORIES} for a code test) and the reason is not empty.
 */
export function parseClassification(
  answer: string,
  categories: readonly TriageCategory[] = TRIAGE_CATEGORIES,
): { proposed: TriageCategory; reason: string } | null {
  const lines = answer.split(/\r?\n/);
  return lastLabelled(lines, 'classification')
    .bind(({ at, value }) => {
      const category = value
        .replace(/[*_`"'“”]/g, '')
        .replace(/[\s-]+/g, ' ')
        .trim()
        .toLowerCase();
      const reason = lastLabelled(lines.slice(at + 1), 'reason')
        .match(
          (found) => found.value,
          () => '',
        )
        .replace(/^[\s*_]+|[\s*_]+$/g, '');
      return Option.from(
        categories.find(
          (known) => category === known || new RegExp(`^${known}(?![a-z])`).test(category),
        ),
      )
        .filter(() => reason !== '')
        .map((proposed) => ({ proposed, reason }));
    })
    .match<{ proposed: TriageCategory; reason: string } | null>(
      (parsed) => parsed,
      () => null,
    );
}

/** The value after `<label>:` on a line, with markdown allowed around the label. */
function labelled(label: string, line: string): Option<string> {
  return Option.from(
    new RegExp(`^[\\s#*>_-]*${label}[\\s*_]*:[\\s*_]*(.*)$`, 'i').exec(line),
  ).map((match) => match[1] as string);
}

/** The last line with a `<label>:` value: its index and the value. */
function lastLabelled(
  lines: readonly string[],
  label: string,
): Option<{ at: number; value: string }> {
  for (let at = lines.length - 1; at >= 0; at--) {
    const value = labelled(label, lines[at] as string);
    if (value.isSome()) return value.map((found) => ({ at, value: found }));
  }
  return Option.none();
}

type Run = { name: string; dir: string; summary: RunSummary };

/** The newest results directory with a `summary.json`, and that summary. */
async function latestRun(results: string): Promise<Run> {
  const names = await TryAsync.runAsync(() => readdir(results)).onFail((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  });
  const newestFirst = names
    .filter((n) => RUN_DIR.test(n))
    .sort()
    .reverse();
  const latest = await foldAsync(newestFirst, Option.none<Run>(), (found, name) =>
    found.isSome() ? found : readRun(results, name),
  );
  return valueOrThrow(
    latest.toEither(
      () => `no run with a summary.json in ${results}: run \`skill-be run\` before triage`,
    ),
  );
}

/** The run in `<results>/<name>`; none when it has no `summary.json`. */
async function readRun(results: string, name: string): Promise<Option<Run>> {
  const dir = path.join(results, name);
  const file = path.join(dir, 'summary.json');
  const text = await TryAsync.runAsync(() => readFile(file, 'utf8')).match(
    (content) => Option.some(content),
    (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return Option.none<string>();
      throw error;
    },
  );
  return text.map((content) => ({
    name,
    dir,
    summary: valueOrThrow(parseSummary(content).mapLeft((message) => `${file}: ${message}`)),
  }));
}

function parseSummary(text: string): Either<string, RunSummary> {
  return Try.run((): unknown => JSON.parse(text)).match(
    (data) =>
      typeof data === 'object' && data !== null && Array.isArray((data as RunSummary).skills)
        ? Either.right<string, RunSummary>(data as RunSummary)
        : Either.left<string, RunSummary>('not a skill-be summary (no "skills" list)'),
    (error) => Either.left<string, RunSummary>(`invalid JSON (${(error as Error).message})`),
  );
}

/** How the report and the notes name a failure: its skill, scenario and model. */
function where(skill: string, scenario: string, model: string): string {
  return `\`${skill}\` / \`${scenario}\` / ${model}`;
}

/**
 * The failures of the given suites in a run summary, in suite, scenario, scored line and model
 * order (the criteria, then the code tests), with a note in its place for each skill or failure
 * that is not triaged. A code test is matched by name later, by {@link withCodeTests}.
 */
function selectTargets(
  summary: RunSummary,
  suites: readonly SkillSuite[],
  models: readonly AdapterSettings[],
  below: number | undefined,
): Either<string, Target>[] {
  const labels = modelLabels(models);
  const selection: Either<string, Target>[] = [];
  const note = (text: string): void => void selection.push(Either.left(text));

  for (const suite of suites) {
    const skill = summary.skills.find((s) => s.skill === suite.name);
    if (!skill) {
      note(`\`${suite.name}\`: not in this run.`);
      continue;
    }
    const errors = skill.blocks.filter((block) => block.kind === 'error').length;
    if (errors > 0) {
      note(
        `\`${suite.name}\`: the error block (${skill.errorCount} output(s) could not be ` +
          'generated or graded) names no criterion and is not triaged; see the notes of the run.',
      );
    }

    const causes = failureCauses(skill, below);
    for (const summaryScenario of skill.scenarios) {
      // The scored lines, as the summary indexes its scores. A summary older than code tests
      // has no `tests`.
      const lines: Array<{ criterion: string } | { test: string }> = [
        ...summaryScenario.criteria.map((criterion) => ({ criterion })),
        ...(summaryScenario.tests ?? []).map((test) => ({ test })),
      ];
      lines.forEach((summaryLine, c) => {
        for (const model of summaryScenario.models) {
          const why = causes.get(key(summaryScenario.id, c, model.model));
          if (!why) continue;
          const at = where(suite.name, summaryScenario.id, model.model);
          const found = (index: number): Option<number> => Option.from(index, (i) => i === -1);
          const lineIn = (scenario: Scenario): Either<string, Line> =>
            'test' in summaryLine
              ? Either.right<string, Line>(summaryLine)
              : found(scenario.criteria.indexOf(summaryLine.criterion))
                  .map((criterion): Line => ({ criterion }))
                  .toEither(
                    () =>
                      `${at}: the eval file no longer has the criterion ` +
                      `"${summaryLine.criterion}"; not triaged.`,
                  );
          const entry = Option.from(suite.scenarios.find((s) => s.id === summaryScenario.id))
            .toEither(() => `${at}: the eval file no longer has this scenario; not triaged.`)
            .bind((scenario) => lineIn(scenario).map((line) => ({ scenario, line })))
            .bind(({ scenario, line }) =>
              found(labels.indexOf(model.model))
                .map(
                  (m): Target => ({
                    suite,
                    scenario,
                    line,
                    label: model.model,
                    settings: models[m] as AdapterSettings,
                    causes: why,
                    score: model.criteria[c] ?? { baselinePct: 0, withSkillPct: 0 },
                  }),
                )
                .toEither(() => `${at}: the config no longer has this model; not triaged.`),
            );
          selection.push(entry);
        }
      });
    }
  }
  return selection;
}

/**
 * The selection with each code test matched by name in the current code tests, prepared once for
 * the suites with a code test to triage: the target gets the prepared scenario, whose `tests` are
 * filled, and a test they no longer have becomes a note. Without a code test, nothing is
 * prepared.
 *
 * @throws Error when a code test is to be triaged and `prepare` is not given.
 */
async function withCodeTests(
  selection: Either<string, Target>[],
  prepare: ((suites: SkillSuite[]) => Promise<TestRunner>) | undefined,
): Promise<{ selection: Either<string, Target>[]; codeTests: TestRunner | null }> {
  const tested = [
    ...new Set(
      selection.flatMap((entry) =>
        entry.match((target) => ('test' in target.line ? [target.suite] : []), () => []),
      ),
    ),
  ];
  if (tested.length === 0) return { selection, codeTests: null };
  if (prepare === undefined) {
    throw new Error(
      `skill "${(tested[0] as SkillSuite).name}" has code tests to triage, ` +
        'but no prepareCodeTests was given',
    );
  }
  const codeTests = await prepare(tested);
  const matched = (target: Target, test: string): Either<string, Target> =>
    Option.from(codeTests.suites.find((suite) => suite.name === target.suite.name))
      .bind((suite) =>
        Option.from(suite.scenarios.find((s) => s.id === target.scenario.id)).map((scenario) => ({
          suite,
          scenario,
        })),
      )
      .filter(({ scenario }) => scenario.tests.includes(test))
      .map(({ suite, scenario }): Target => ({ ...target, suite, scenario }))
      .toEither(
        () =>
          `${where(target.suite.name, target.scenario.id, target.label)}: the code tests no ` +
          `longer have the test "${test}"; not triaged.`,
      );
  return {
    codeTests,
    selection: selection.map((entry) =>
      entry.bind((target) =>
        'test' in target.line ? matched(target, target.line.test) : Either.right(target),
      ),
    ),
  };
}

/** The scored line of a target, as the run's report names it. */
function lineText({ scenario, line }: Target): string {
  return 'test' in line
    ? `${TEST_LINE_PREFIX}${line.test}`
    : (scenario.criteria[line.criterion] as string);
}

/** The number of a target's scored line in its scenario: the criteria first, then the tests. */
function lineNumber({ scenario, line }: Target): number {
  return 'test' in line
    ? scenario.criteria.length + scenario.tests.indexOf(line.test) + 1
    : line.criterion + 1;
}

/** The categories a target is classified into. */
function categoriesOf(target: Target): readonly TriageCategory[] {
  return 'test' in target.line ? TEST_TRIAGE_CATEGORIES : TRIAGE_CATEGORIES;
}

/** Why each (scenario, criterion, model) of a skill is triaged, keyed by {@link key}. */
function failureCauses(skill: SkillSummary, below: number | undefined): Map<string, string[]> {
  const causes = new Map<string, string[]>();
  const add = (scenario: string, criterion: number, model: string, cause: string): void => {
    const k = key(scenario, criterion, model);
    causes.set(k, [...(causes.get(k) ?? []), cause]);
  };

  for (const block of skill.blocks) {
    const scenario = skill.scenarios.find((s) => s.id === block.scenario);
    if (!scenario || block.criterion === undefined) continue;
    const c = block.criterion;
    if (block.kind === 'zero') {
      for (const model of scenario.models) {
        add(scenario.id, c, model.model, 'blocked (universal 0%)');
      }
    } else if (block.kind === 'regression' && block.model !== undefined) {
      add(scenario.id, c, block.model, 'blocked (regression)');
    }
  }

  if (below !== undefined) {
    for (const scenario of skill.scenarios) {
      for (const model of scenario.models) {
        model.criteria.forEach((score, c) => {
          if (score.withSkillPct < below) {
            add(scenario.id, c, model.model, `under ${below}% with the skill`);
          }
        });
      }
    }
  }
  return causes;
}

function key(scenario: string, criterion: number, model: string): string {
  return JSON.stringify([scenario, criterion, model]);
}

const verdictText = (verdict: 0 | 1 | null): string =>
  verdict === null ? 'no verdict' : verdict ? 'YES' : 'NO';

/** A code test's verdict on a sample, as the prompt and the report name it. */
const testVerdictText = (verdict: 0 | 1 | null): string =>
  verdict === null ? 'no verdict' : verdict ? 'PASS' : 'FAIL';

/**
 * The prompt that asks the triage model for a classification of a failing criterion and a
 * one-line reason.
 */
function classificationPrompt(
  target: Target,
  criterion: number,
  samples: readonly Sample[],
): string {
  const { scenario } = target;
  const n = criterion + 1;
  const parts: string[] = [
    'You are triaging a failure in a benchmark of an Agent Skill. The skill is documentation ' +
      'given to a model in its prompt; the model then answers a task, and a grader model ' +
      'judges the answer against numbered criteria. One criterion keeps failing with the ' +
      'skill. Below are the skill, the task, the criteria, and fresh answers written with the ' +
      "skill, each with the grader's verdict on that criterion and the grader's reasons.",
    '',
    'Classify the failure into exactly one of these categories:',
    ...TRIAGE_CATEGORIES.map((category) => `- ${category}: ${DEFINITIONS[category]};`),
    '',
    `<skill>\n${target.suite.skillText}\n</skill>`,
    '',
    `<task>\n${scenario.prompt}\n</task>`,
    '',
    `Criteria (the grader judged them together):\n` +
      scenario.criteria.map((text, i) => `${i + 1}. ${text}`).join('\n'),
    '',
    `The failing criterion is number ${n}: "${scenario.criteria[criterion]}"`,
    `In the benchmark run, ${target.label} met it in ${target.score.baselinePct}% of the ` +
      `answers without the skill and in ${target.score.withSkillPct}% with it.`,
  ];

  samples.forEach((sample, i) => {
    if (!('gradings' in sample)) return;
    parts.push(
      '',
      `<sample number="${i + 1}" ` +
        `grader-verdict-on-criterion-${n}="${verdictText(sample.verdict)}">`,
      `<answer>\n${sample.output}\n</answer>`,
      ...sample.gradings.map(
        (grading, k) =>
          `<grader-reasons grading="${k + 1}" verdict="${verdictText(grading.verdict)}">\n` +
          `${grading.reasons}\n</grader-reasons>`,
      ),
      '</sample>',
    );
  });

  parts.push(
    '',
    `Check the answer against criterion ${n} yourself before trusting the grader. Then end your ` +
      'reply with exactly these two lines and nothing after them:',
    `CLASSIFICATION: <one of: ${TRIAGE_CATEGORIES.join(', ')}>`,
    'REASON: <one line saying why, citing the answer>',
  );
  return parts.join('\n');
}

/**
 * The prompt that asks the triage model for a classification of a failing code test and a
 * one-line reason: the task with its answer format, the test file's source, and each sample with
 * the test's result and message.
 */
function testClassificationPrompt(
  target: Target,
  test: string,
  samples: readonly Sample[],
  source: string,
): string {
  const { scenario } = target;
  const task = Option.from(scenario.output).match(
    (output) => `${scenario.prompt}\n\n${contractParagraph(output)}`,
    () => scenario.prompt,
  );
  const parts: string[] = [
    'You are triaging a failure in a benchmark of an Agent Skill. The skill is documentation ' +
      'given to a model in its prompt; the model then answers a task with code, and the code is ' +
      'run against the tests of the task. One test keeps failing with the skill. Below are the ' +
      'skill, the task, the test file, and fresh answers written with the skill, each with the ' +
      "test's result and its message.",
    '',
    'Classify the failure into exactly one of these categories:',
    ...TEST_TRIAGE_CATEGORIES.map((category) => `- ${category}: ${DEFINITIONS[category]};`),
    '',
    `<skill>\n${target.suite.skillText}\n</skill>`,
    '',
    `<task>\n${task}\n</task>`,
    '',
    `<test-file>\n${source}\n</test-file>`,
    '',
    `The failing test is "${test}".`,
    `In the benchmark run, ${target.label} passed it in ${target.score.baselinePct}% of the ` +
      `answers without the skill and in ${target.score.withSkillPct}% with it.`,
  ];

  samples.forEach((sample, i) => {
    if (!('testMessage' in sample)) return;
    parts.push(
      '',
      `<sample number="${i + 1}" test-result="${testVerdictText(sample.verdict)}">`,
      `<answer>\n${sample.output}\n</answer>`,
      ...(sample.testMessage === ''
        ? []
        : [`<test-message>\n${sample.testMessage}\n</test-message>`]),
      '</sample>',
    );
  });

  parts.push(
    '',
    'Check the answer against the test and the task yourself before trusting the test. Then end ' +
      'your reply with exactly these two lines and nothing after them:',
    `CLASSIFICATION: <one of: ${TEST_TRIAGE_CATEGORIES.join(', ')}>`,
    'REASON: <one line saying why, citing the answer or the test>',
  );
  return parts.join('\n');
}

type RenderInfo = {
  run: string;
  samples: number;
  gradings: number;
  grader: AdapterSettings;
  /** `triage.model`; `null` means each failure is classified by its own model under test. */
  classifier: AdapterSettings | null;
};

/** The markdown triage report: the proposals, what was not triaged, then each failure in full. */
function renderTriage(
  triaged: readonly Triaged[],
  notes: readonly string[],
  info: RenderInfo,
): string {
  const out: string[] = [];
  out.push(`# Triage of run ${info.run}`);
  out.push('');
  out.push(
    'Proposed classifications of the failing criteria, for a human to confirm. ' +
      'Triage never blocks a release.',
  );
  out.push('');
  const lines = triaged.map(({ target }) => target.line);
  const { grader } = info;
  const graded = `graded ${info.gradings} time(s) by ${grader.id} (via ${grader.adapter})`;
  const ran = 'run against the code tests';
  const how = !lines.some((line) => 'test' in line)
    ? graded
    : !lines.some((line) => 'criterion' in line)
      ? ran
      : `${graded} for a criterion, ${ran} for a code test`;
  out.push(
    `Method: ${info.samples} fresh with-skill sample(s) per failure, each ${how}; ` +
      Option.from(info.classifier).match(
        (classifier) => `classified by ${classifier.id} (via ${classifier.adapter}).`,
        () => 'classified by the model under test whose output failed.',
      ),
  );
  out.push('');

  if (triaged.length === 0) {
    out.push('No failing criteria to triage.');
    out.push('');
  } else {
    out.push('| Skill | Scenario | Model | Criterion | Proposed |');
    out.push('|-------|----------|-------|-----------|----------|');
    for (const { item } of triaged) {
      out.push(
        `| ${cell(item.skill)} | ${cell(item.scenario)} | ${cell(item.model)} | ` +
          `${cell(item.criterion)} | ${item.proposed} |`,
      );
    }
    out.push('');
  }

  if (notes.length > 0) {
    out.push('## Not triaged');
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
    out.push('');
  }

  for (const { target, samples, item } of triaged) {
    out.push(`## \`${item.skill}\` / \`${item.scenario}\` / ${item.model}`);
    out.push('');
    out.push(`Criterion ${lineNumber(target)}: *"${item.criterion}"*`);
    out.push('');
    out.push(
      `Why: ${target.causes.join('; ')}. In the run: baseline ${target.score.baselinePct}%, ` +
        `with skill ${target.score.withSkillPct}%.`,
    );
    out.push('');
    out.push(`Task: *${target.scenario.prompt}*`);
    out.push('');
    if (item.proposed === 'unclassified') {
      out.push(`**Unclassified** — ${item.reason}`);
      Option.from(item.rawAnswer).onSome((rawAnswer) => {
        out.push('');
        out.push('Raw answer of the triage model:');
        out.push('');
        out.push(fenced(rawAnswer));
      });
    } else {
      out.push(`**Proposed: ${item.proposed}** — ${item.reason}`);
    }
    out.push('');

    samples.forEach((sample, i) => {
      if ('error' in sample) {
        out.push(`### Sample ${i + 1} — generation failed`);
        out.push('');
        out.push(`[ERROR] ${sample.error}`);
        out.push('');
        return;
      }
      if ('testMessage' in sample) {
        out.push(`### Sample ${i + 1} — test: ${testVerdictText(sample.verdict)}`);
        out.push('');
        out.push(fenced(sample.output));
        out.push('');
        if (sample.testMessage !== '') {
          out.push(sample.verdict === null ? 'Why there is no verdict:' : 'Test message:');
          out.push('');
          out.push(fenced(sample.testMessage));
          out.push('');
        }
        return;
      }
      out.push(`### Sample ${i + 1} — grader: ${verdictText(sample.verdict)}`);
      out.push('');
      out.push(fenced(sample.output));
      out.push('');
      sample.gradings.forEach((grading, k) => {
        out.push(`Grader reasons, grading ${k + 1} (${verdictText(grading.verdict)}):`);
        out.push('');
        out.push(fenced(grading.reasons));
        out.push('');
      });
    });
  }

  return `${out.join('\n')}\n`;
}

/** `text` in a code fence longer than any run of backticks inside it, so it cannot close early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${fence}`;
}

/** An error message on one line. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}
