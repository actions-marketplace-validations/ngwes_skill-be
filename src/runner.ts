import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Option, TryAsync, repeatWhile } from '@ngwes/mini-fp';
import { isConfigProblem, resolveAdapter, type Adapter } from './adapters/index.js';
import { armPrompts } from './code-tests/contract.js';
import type { TestOutcome } from './code-tests/execute.js';
import type { CodeTests } from './code-tests/runtime.js';
import { gradeOutput, type Verdicts } from './grader.js';
import { createLimiter } from './limiter.js';
import { scoredLines } from './scored-lines.js';
import type { AdapterSettings, Config, Scenario, SkillSuite } from './types.js';

/**
 * One scored line's share of YES verdicts (a criterion) or passes (a test) over the reps, as a
 * rounded percentage per arm.
 */
export type CriterionScore = { baselinePct: number; withSkillPct: number };

export type ModelResult = {
  /** The model's label: its id, or `adapter:id` when several models under test share the id. */
  model: string;
  /** One score per line of `scoredLines(scenario)`: the criteria, then the tests. */
  criteria: CriterionScore[];
  /** `[ERROR] ...` notes first, then `[NOTE] ...` notes, each naming the rep and arm. */
  notes: string[];
  /**
   * One per output that could not be generated (all its lines counted as 0), and one per output
   * whose gradings all failed or whose tests could not run (that part's lines counted as 0).
   */
  errors: number;
  /** One entry per rep, in rep order: what each arm answered, the grader replied, the tests said. */
  outputs: RepOutputs[];
};

/**
 * One arm's output as its file holds it (`[ERROR: ...]` when it could not be generated), the
 * grader's raw answers as their files hold them, and the outcome of each code test, in the
 * scenario's test order. Neither the grader nor the tests run for an output that was not
 * generated, and neither runs for a scenario with no criteria or no tests: both are `[]` then.
 */
export type ArmOutput = { output: string; gradings: string[]; tests: TestOutcome[] };

/** Both arms of one rep, by their name in file names. */
export type RepOutputs = Record<Arm, ArmOutput>;

export type ScenarioResult = { scenario: Scenario; models: ModelResult[] };

export type SkillRun = {
  skill: string;
  /** In eval file order, each with its models in config order. */
  scenarios: ScenarioResult[];
  errorCount: number;
  /** ISO time the run started. */
  startedAt: string;
  durationMs: number;
};

export type RunDeps = {
  /** Resolves an entry's adapter; `resolveAdapter` against the config root by default. */
  adapterFor?: (settings: AdapterSettings) => Promise<Adapter>;
  /** Receives one progress line at a time; stderr by default. */
  log?: (line: string) => void;
  /**
   * The results subdirectory, `<results>/<timestamp>/<skill>/...`, so several skills of one run
   * share it. A new {@link resultsTimestamp} by default.
   */
  timestamp?: string;
  /**
   * Runs a scenario's code tests against an output; required when a scenario has tests (see
   * `prepareCodeTests`).
   */
  codeTests?: Pick<CodeTests, 'run'>;
};

/** The arms, by their name in file names. */
const ARMS = ['baseline', 'with-skill'] as const;

export type Arm = (typeof ARMS)[number];

/** How progress lines and notes name each arm, as run-benchmark.mjs does. */
const ARM_LABELS: Record<Arm, string> = { baseline: 'baseline', 'with-skill': 'with skill' };

/** A model under test with its resolved adapter, its label and its results directory name. */
type Model = { settings: AdapterSettings; adapter: Adapter; label: string; dir: string };

/**
 * One scored output: a 0 or 1 per scored line (0 for a line that could not be scored), its notes,
 * its errors and its texts.
 */
type OutputResult = { verdicts: Verdicts; notes: string[]; errors: number; kept: ArmOutput };

/**
 * One part of an output's score, the judge's or the tests': a 0 or 1 per line of that part, its
 * notes, its errors and what the progress line says of it (`null` when the part has no lines).
 */
type Part = { verdicts: Verdicts; notes: string[]; errors: number; outcome: string | null };

/** The part of a scenario without criteria or without tests. */
const NO_LINES: Part = { verdicts: [], notes: [], errors: 0, outcome: null };

/**
 * Runs the benchmark of one skill: for every scenario and every model under test, `reps`
 * generations per arm (baseline and with skill), each graded `gradings` times when the scenario
 * has criteria and run against its code tests when it has tests. Every generation, grading call
 * and test run goes through one limiter of `config.concurrency`.
 *
 * Writes each output to `<results>/<timestamp>/<skill>/<scenario>/<model>/rep-<n>-<arm>.md`,
 * each raw grader answer beside it as `rep-<n>-<arm>.grading-<k>.md` and its test outcomes as
 * `rep-<n>-<arm>.tests.json`. An output that could not be generated counts every line as 0; one
 * whose gradings all failed counts the criteria as 0; one whose tests could not run counts the
 * tests as 0. Each of these carries an `[ERROR]` note and adds to `errorCount`; a test the answer
 * fails is a score, not an error. What that means for the verdict is the gate's business. A
 * `ConfigError` an adapter throws, or a CLI that cannot start, is not an output error: it rejects
 * `runSkill`, so the CLI can exit with 2 (see `isConfigProblem`).
 *
 * @throws Error, before any call, when a scenario has tests and `deps.codeTests` is not given.
 */
export async function runSkill(
  suite: SkillSuite,
  config: Config,
  deps: RunDeps = {},
): Promise<SkillRun> {
  const started = Date.now();
  const codeTests = deps.codeTests;
  const tested = suite.scenarios.find((scenario) => scenario.tests.length > 0);
  if (tested !== undefined && codeTests === undefined) {
    throw new Error(
      `scenario "${tested.id}" of skill "${suite.name}" has code tests, ` +
        'but no codeTests were given',
    );
  }
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const adapterFor =
    deps.adapterFor ??
    ((settings: AdapterSettings) => resolveAdapter(settings.adapter, config.root));
  const runDir = path.join(
    config.results,
    deps.timestamp ?? resultsTimestamp(new Date(started)),
    suite.name,
  );

  // Resolve every adapter before the first call, so a config error stops the run at once.
  const modelAdapters = await Promise.all(config.models.map((settings) => adapterFor(settings)));
  const graderAdapter = await adapterFor(config.grader);

  const limit = createLimiter(config.concurrency);
  const timeoutMs = config.timeoutSeconds * 1000;
  const call = (adapter: Adapter, settings: AdapterSettings, prompt: string): Promise<string> =>
    limit(() => adapter(prompt, { settings, timeoutMs, cwd: config.root }));
  const grade = (prompt: string): Promise<string> => call(graderAdapter, config.grader, prompt);

  const labels = modelLabels(config.models);
  const modelDirs = uniqueSegments(labels);
  const models: Model[] = config.models.map((settings, i) => ({
    settings,
    adapter: modelAdapters[i] as Adapter,
    label: labels[i] as string,
    dir: modelDirs[i] as string,
  }));
  const scenarioDirs = uniqueSegments(suite.scenarios.map((scenario) => scenario.id));
  const totalReps = suite.scenarios.length * models.length * config.reps;
  let doneReps = 0;

  log(
    `${suite.name}: ${suite.scenarios.length} scenarios × ${models.length} model(s) × ` +
      `${config.reps} reps, concurrency ${config.concurrency}`,
  );

  /**
   * Grades one output against the scenario's criteria and writes the grader's answers; nothing
   * to do for a scenario without criteria.
   */
  async function judge(
    scenario: Scenario,
    output: string,
    file: string,
  ): Promise<Part & { rawAnswers: string[] }> {
    if (scenario.criteria.length === 0) return { ...NO_LINES, rawAnswers: [] };
    const graded = await gradeOutput(
      scenario.criteria,
      output,
      grade,
      config.gradings,
      config.graderPrompt ?? undefined,
    );
    await Promise.all(
      graded.rawAnswers.map((answer, k) => writeFile(`${file}.grading-${k + 1}.md`, answer)),
    );
    const part = Option.from(graded.verdicts).match<Part>(
      (verdicts) => ({
        verdicts,
        notes: graded.notes,
        errors: 0,
        outcome: `${verdicts.reduce<number>((sum, v) => sum + v, 0)}/${verdicts.length} YES`,
      }),
      // `notes` then holds the one `[ERROR]` note of the failure.
      () => ({
        verdicts: zeros(scenario.criteria),
        notes: graded.notes,
        errors: 1,
        outcome: 'grading FAILED',
      }),
    );
    return { ...part, rawAnswers: graded.rawAnswers };
  }

  /**
   * Runs the scenario's code tests against one output and writes their outcomes; nothing to do
   * for a scenario without tests. A test the answer fails scores 0; tests that could not run
   * score 0 and count as an error.
   */
  async function runTests(
    scenario: Scenario,
    output: string,
    file: string,
  ): Promise<Part & { outcomes: TestOutcome[] }> {
    // `runSkill` checked up front that every scenario with tests has `codeTests`.
    if (scenario.tests.length === 0 || codeTests === undefined) {
      return { ...NO_LINES, outcomes: [] };
    }
    const { outcomes, infraError } = await limit(() =>
      codeTests.run(suite.name, scenario.id, output),
    );
    await writeFile(`${file}.tests.json`, `${JSON.stringify(outcomes, null, 2)}\n`);
    const part = Option.from(infraError).match<Part>(
      (reason) => ({
        verdicts: zeros(scenario.tests),
        notes: [`[ERROR] code tests could not run: ${oneLine(reason)}`],
        errors: 1,
        outcome: 'tests could not run',
      }),
      () => {
        const verdicts: Verdicts = outcomes.map((outcome) => (outcome.pass ? 1 : 0));
        const passed = verdicts.reduce<number>((sum, v) => sum + v, 0);
        return {
          verdicts,
          notes: [],
          errors: 0,
          outcome: `${passed}/${verdicts.length} tests passed`,
        };
      },
    );
    return { ...part, outcomes };
  }

  /** Generates one output, writes it, then grades it and runs its tests side by side. */
  async function runOutput(
    scenario: Scenario,
    model: Model,
    prompt: string,
    file: string,
    tag: string,
  ): Promise<OutputResult> {
    const t0 = Date.now();
    return TryAsync.runAsync(() => call(model.adapter, model.settings, prompt)).match(
      async (output) => {
        await writeFile(`${file}.md`, output);

        const [judged, tested] = await Promise.all([
          judge(scenario, output, file),
          runTests(scenario, output, file),
        ]);
        const outcome = [judged.outcome, tested.outcome].filter((part) => part !== null);
        log(`  ${tag}: ${outcome.join(', ')} (${seconds(Date.now() - t0)})`);
        return {
          verdicts: [...judged.verdicts, ...tested.verdicts],
          notes: [...judged.notes, ...tested.notes],
          errors: judged.errors + tested.errors,
          kept: { output, gradings: judged.rawAnswers, tests: tested.outcomes },
        };
      },
      async (error) => {
        // A config problem is the user's to fix: it stops the run (exit 2), not an output error.
        if (isConfigProblem(error)) throw error;
        const message = oneLine(error instanceof Error ? error.message : String(error));
        const text = `[ERROR: ${message}]\n`;
        await writeFile(`${file}.md`, text);
        log(`  ${tag}: generation failed — ${message.slice(0, 200)}`);
        return {
          verdicts: zeros(scoredLines(scenario)),
          notes: [`[ERROR] generation failed, criteria counted as 0: ${message}`],
          errors: 1,
          kept: { output: text, gradings: [], tests: [] },
        };
      },
    );
  }

  /** Both arms of one rep, run side by side. */
  async function runRep(
    scenario: Scenario,
    model: Model,
    dir: string,
    rep: number,
  ): Promise<Record<Arm, OutputResult>> {
    const label = `[${scenario.id}] ${model.label} rep ${rep}/${config.reps}`;
    const arm = (name: Arm, prompt: string): Promise<OutputResult> =>
      runOutput(
        scenario,
        model,
        prompt,
        path.join(dir, `rep-${rep}-${name}`),
        `${label} ${ARM_LABELS[name]}`,
      );
    const prompts = armPrompts(config.withSkillTemplate, suite.skillText, scenario);
    const [baseline, withSkill] = await Promise.all([
      arm('baseline', prompts.baseline),
      arm('with-skill', prompts.withSkill),
    ]);
    doneReps++;
    log(
      `  ${label} done (${doneReps}/${totalReps} reps, ` +
        `${seconds(Date.now() - started)} elapsed)`,
    );
    return { baseline, 'with-skill': withSkill };
  }

  /** Every rep of one model on one scenario, scored per line of `scoredLines(scenario)`. */
  async function runModel(
    scenario: Scenario,
    scenarioDir: string,
    model: Model,
  ): Promise<ModelResult> {
    const dir = path.join(runDir, scenarioDir, model.dir);
    await mkdir(dir, { recursive: true });
    const reps = await Promise.all(
      Array.from({ length: config.reps }, (_, r) => runRep(scenario, model, dir, r + 1)),
    );

    const pct = (arm: Arm, line: number): number => {
      const yes = reps.reduce((sum, rep) => sum + (rep[arm].verdicts[line] ?? 0), 0);
      return Math.round((yes / config.reps) * 100);
    };
    const notes = reps.flatMap((rep, r) =>
      ARMS.flatMap((arm) =>
        rep[arm].notes.map((note) => inContext(note, `rep ${r + 1} ${ARM_LABELS[arm]}`)),
      ),
    );
    return {
      model: model.label,
      criteria: scoredLines(scenario).map((_, line) => ({
        baselinePct: pct('baseline', line),
        withSkillPct: pct('with-skill', line),
      })),
      // Errors first, as run-benchmark.mjs lists them.
      notes: [
        ...notes.filter((note) => note.startsWith('[ERROR]')),
        ...notes.filter((note) => !note.startsWith('[ERROR]')),
      ],
      errors: reps.reduce(
        (sum, rep) => sum + ARMS.reduce((n, arm) => n + rep[arm].errors, 0),
        0,
      ),
      outputs: reps.map((rep) => ({
        baseline: rep.baseline.kept,
        'with-skill': rep['with-skill'].kept,
      })),
    };
  }

  const scenarios: ScenarioResult[] = await Promise.all(
    suite.scenarios.map(async (scenario, s) => ({
      scenario,
      models: await Promise.all(
        models.map((model) => runModel(scenario, scenarioDirs[s] as string, model)),
      ),
    })),
  );

  const errorCount = scenarios.reduce(
    (sum, result) => sum + result.models.reduce((n, model) => n + model.errors, 0),
    0,
  );
  const durationMs = Date.now() - started;
  log(
    `${suite.name}: finished in ${seconds(durationMs)}` +
      `${errorCount ? `, ${errorCount} error(s)` : ''}`,
  );

  return {
    skill: suite.name,
    scenarios,
    errorCount,
    startedAt: new Date(started).toISOString(),
    durationMs,
  };
}

/**
 * One label per model under test: its id, or `adapter:id` when another entry has the same id.
 * Entries that share both are numbered (`adapter:id#1`, `adapter:id#2`) so labels stay unique.
 */
export function modelLabels(models: readonly AdapterSettings[]): string[] {
  const named = models.map((model) =>
    models.filter((other) => other.id === model.id).length > 1
      ? `${model.adapter}:${model.id}`
      : model.id,
  );
  return named.map((label, i) =>
    named.filter((other) => other === label).length > 1
      ? `${label}#${named.slice(0, i + 1).filter((other) => other === label).length}`
      : label,
  );
}

/** A filesystem-safe ISO time for the results directory: `2026-10-31T09-05-03-042Z`. */
export function resultsTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** The template with `{{skill}}` and `{{task}}` filled in one pass, so neither text is re-read. */
export function fillTemplate(template: string, skill: string, task: string): string {
  return template.replace(/\{\{(skill|task)\}\}/g, (_, key: string) =>
    key === 'skill' ? skill : task,
  );
}

/** `[LEVEL] text` -> `[LEVEL] <context> — text`, as run-benchmark.mjs names the rep and arm. */
function inContext(note: string, context: string): string {
  return note.replace(/^(\[(?:ERROR|NOTE)\]) /, (_, level: string) => `${level} ${context} — `);
}

/**
 * Directory names for labels or ids: characters that Windows or POSIX paths forbid become `_`,
 * and so do trailing dots and spaces, which Windows drops (this also covers `.` and `..`). A name
 * that then repeats an earlier one, ignoring case as Windows does, gets `-2`, `-3`, ...
 */
function uniqueSegments(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '_') || '_';
    const { unique } = repeatWhile(
      () => ({ unique: safe, next: 2 }),
      (candidate) => used.has(candidate.unique.toLowerCase()),
      ({ next }) => ({ unique: `${safe}-${next}`, next: next + 1 }),
    );
    used.add(unique.toLowerCase());
    return unique;
  });
}

/** A 0 verdict per line: the score of lines that could not be scored. */
function zeros(lines: readonly string[]): Verdicts {
  return lines.map((): 0 => 0);
}

/** An error message on one line, so it fits in a note and a markdown list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
