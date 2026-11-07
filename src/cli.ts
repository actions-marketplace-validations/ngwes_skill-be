#!/usr/bin/env node
/**
 * The `skill-be` command: `run`, `verify`, `check` and `triage`. `main` returns the exit code: 0
 * when every skill is READY and every blocking check passes, 1 when anything blocks, 2 for a
 * usage or config error. Only the entry point at the bottom exits the process.
 */

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Option, Try, TryAsync } from '@ngwes/mini-fp';
import { isConfigProblem } from './adapters/index.js';
import { apiWords, coverage, validateCoverage } from './checks/coverage.js';
import { typecheckSkill, validateTypecheck } from './checks/typecheck.js';
import { loadTypescript } from './checks/typescript.js';
import { syntaxErrors } from './code-tests/compile.js';
import { contractHints } from './code-tests/hints.js';
import { prepareCodeTests, type CodeTests } from './code-tests/runtime.js';
import { loadConfig } from './config.js';
import { skillFingerprint } from './fingerprint.js';
import { evaluateGate, type GateVerdict } from './gate.js';
import { renderHtml } from './html-report.js';
import { killActiveChildren } from './process.js';
import { renderReport, toSummary } from './report.js';
import {
  mergeResults,
  readResultFile,
  skillBeVersion,
  verifyResults,
  writeResultFile,
  type ResultFile,
  type SkillEntry,
} from './result-file.js';
import { modelLabels, resultsTimestamp, runSkill, type SkillRun } from './runner.js';
import { loadSuites } from './suite.js';
import { triage, type TriageOptions } from './triage.js';
import { ConfigError, type Config, type SkillSuite } from './types.js';

export type Writer = { write(text: string): unknown };

export type Io = {
  stdout: Writer;
  stderr: Writer;
  cwd: string;
  /**
   * Aborted when the process is told to stop (Ctrl+C): a run then writes no more results. The
   * entry point exits with the signal's code.
   */
  signal?: AbortSignal;
};

const USAGE = `Usage: skill-be <command> [options]

Benchmarks Agent Skills: baseline versus with-skill, LLM-graded and gated.

Commands:
  run [skill...]     Benchmark every skill that has an eval file, or the named ones. Writes
                     the outputs, the grader answers, a report per skill and summary.json
                     under the results directory, updates the result file, then runs the checks.
  verify             Without a model call: checks that the result file matches the current
                     skills, evals and config and records every skill READY, then runs the checks.
  check              Runs the typecheck and coverage checks, and parses the code tests.
  triage [skill...]  Proposes a classification for each failing criterion or code test of the
                     latest run. Never blocks.

Options:
  --config <path>    The config file (default: ./skill-be.yaml)
  --reps <n>         run: generations per arm per scenario, instead of the config's
  --concurrency <n>  run: model calls in flight at once, instead of the config's
  --html             run: also writes results.html beside summary.json, with every answer
  --keep-deps        run, triage: keeps the installed test packages in .skill-be/deps for the next run
  --below <pct>      triage: also triage criteria that scored under pct% with the skill
  --samples <n>      triage: fresh with-skill samples per failing criterion (default: 2)
  -h, --help         Shows this help

Exit codes: 0 when every skill is READY and every blocking check passes, 1 when anything
blocks, 2 for a usage or config error.
`;

/** A mistake on the command line (exit code 2, with a pointer to the help). */
class UsageError extends Error {
  override name = 'UsageError';
}

type CommandName = 'run' | 'verify' | 'check' | 'triage';

type Args = {
  command: CommandName;
  skills: string[];
  options: Map<string, string>;
  flags: Set<string>;
};

/**
 * What each command accepts: its options with a value and its flags without one (both without
 * `--`), and whether it takes skill names.
 */
const SYNTAX: Record<CommandName, { options: string[]; flags: string[]; skills: boolean }> = {
  run: { options: ['config', 'reps', 'concurrency'], flags: ['html', 'keep-deps'], skills: true },
  verify: { options: ['config'], flags: [], skills: false },
  check: { options: ['config'], flags: [], skills: false },
  triage: { options: ['config', 'below', 'samples'], flags: ['keep-deps'], skills: true },
};

/** What a command prints with and where it is run from. */
type Context = {
  /** Writes text to stdout as it is. */
  write: (text: string) => void;
  out: (line?: string) => void;
  err: (line: string) => void;
  /** A path as the user reads it: relative to the working directory when it is inside it. */
  show: (file: string) => string;
  cwd: string;
  /** Throws {@link Stopped} once the process is told to stop. */
  throwIfStopped: () => void;
};

/** The process was told to stop: the command ends without writing more. */
class Stopped extends Error {
  override name = 'Stopped';
}

const COMMANDS: Record<CommandName, (args: Args, ctx: Context) => Promise<number>> = {
  run: runCommand,
  verify: verifyCommand,
  check: checkCommand,
  triage: triageCommand,
};

/** Runs the command `argv` names (without the node and script paths) and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const err = (line: string): void => void io.stderr.write(`${line}\n`);
  return TryAsync.runAsync(async () => {
    const args = parseArgs(argv);
    if (args === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    return COMMANDS[args.command](args, {
      write: (text) => void io.stdout.write(text),
      out: (line = '') => void io.stdout.write(`${line}\n`),
      err,
      show: (file) => {
        const relative = path.relative(io.cwd, file);
        const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        return inside ? relative : file;
      },
      cwd: io.cwd,
      throwIfStopped: () => {
        if (io.signal?.aborted === true) throw new Stopped('stopped');
      },
    });
  }).onFail((error) => {
    // The entry point exits with the signal's code; the code returned here is not used.
    if (error instanceof Stopped) return 130;
    if (error instanceof UsageError) {
      err(`skill-be: ${error.message}`);
      err('Run "skill-be --help" for usage.');
      return 2;
    }
    // A config error, or a CLI that could not start: the user's to fix, not a skill's verdict.
    if (isConfigProblem(error)) {
      err(`skill-be: ${(error as Error).message}`);
      return 2;
    }
    err(`skill-be: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  });
}

function parseArgs(argv: string[]): Args | 'help' {
  if (argv[0] === 'help' || argv.some((arg) => arg === '--help' || arg === '-h')) return 'help';

  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError('no command given');
  if (!Object.prototype.hasOwnProperty.call(SYNTAX, command)) {
    throw new UsageError(`unknown command "${command}" (commands: run, verify, check, triage)`);
  }
  const name = command as CommandName;
  const syntax = SYNTAX[name];

  const skills: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('-')) {
      skills.push(arg);
      continue;
    }
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    const key = match?.[1];
    if (key !== undefined && syntax.flags.includes(key)) {
      if (match?.[2] !== undefined) throw new UsageError(`--${key} takes no value`);
      flags.add(key);
      continue;
    }
    if (key === undefined || !syntax.options.includes(key)) {
      throw new UsageError(`unknown option ${arg.split('=')[0]} for "${name}"`);
    }
    // `--key=value`, or `--key value`; a value may start with "-" (`--below -1` is then rejected
    // as out of range), but not with "--", which is the next option.
    const value = match?.[2] ?? rest[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${key} needs a value`);
    }
    options.set(key, value);
  }
  if (!syntax.skills && skills.length > 0) {
    throw new UsageError(`${name} takes no skill names (got ${skills.join(' ')})`);
  }
  return { command: name, skills, options, flags };
}

/** The option's value; none when it is not given, a `UsageError` when it is not a valid one. */
function positiveInteger(args: Args, key: string): Option<number> {
  return Option.from(args.options.get(key)).map((raw) => {
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new UsageError(`--${key} must be a positive integer (got "${raw}")`);
    }
    return value;
  });
}

/** The option's value; none when it is not given, a `UsageError` when it is not a valid one. */
function percentage(args: Args, key: string): Option<number> {
  return Option.from(args.options.get(key)).map((raw) => {
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || value > 100) {
      throw new UsageError(`--${key} must be a number from 0 to 100 (got "${raw}")`);
    }
    return value;
  });
}

type Project = {
  config: Config;
  /** Every skill with an eval file: the checks always cover all of them. */
  all: SkillSuite[];
  /** The skills named on the command line, else all of them. */
  selected: SkillSuite[];
};

/**
 * Loads the config and the suites, and prints the warnings about the selected skills. Having no
 * skill to work on is a config error: it never passes silently.
 */
async function loadProject(args: Args, ctx: Context): Promise<Project> {
  const configPath = path.resolve(
    ctx.cwd,
    Option.from(args.options.get('config')).orElse('skill-be.yaml'),
  );
  const config = await loadConfig(configPath);
  const all = await loadSuites(config);
  const selected = args.skills.length > 0 ? await loadSuites(config, args.skills) : all;
  for (const warning of selected.warnings) ctx.err(`warning: ${warning}`);
  if (selected.suites.length === 0) {
    const which = args.skills.length > 0 ? `none of ${args.skills.join(', ')} has` : 'no skill has';
    throw new ConfigError(
      `no skill to ${args.command}: ${which} a SKILL.md in ${config.skills} ` +
        `and an eval file in ${config.evals}`,
    );
  }
  return { config, all: all.suites, selected: selected.suites };
}

/** Throws the `ConfigError` a misconfigured check would throw, without running the checks. */
async function validateChecks(config: Config): Promise<void> {
  const { typecheck, coverage: coverageConfig } = config.checks;
  if (typecheck !== false) await validateTypecheck(typecheck, config.root);
  if (coverageConfig !== false) await validateCoverage(coverageConfig, config.root);
}

/** The checks' output lines, and what they block on (empty when nothing blocks). */
type ChecksOutcome = { lines: string[]; blockers: string[] };

/** Runs the typecheck and the coverage check, when the config enables them, over `suites`. */
async function runChecks(config: Config, suites: SkillSuite[]): Promise<ChecksOutcome> {
  const lines: string[] = [];
  const blockers: string[] = [];

  const typecheck = config.checks.typecheck;
  if (typecheck === false) {
    lines.push('typecheck: off');
  } else {
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const suite of suites) {
      const result = await typecheckSkill(suite, typecheck, config.root);
      problems.push(...result.problems);
      warnings.push(...result.warnings);
    }
    if (problems.length === 0) {
      lines.push(`typecheck: passed (${suites.length} skill(s))`);
    } else {
      const blocks = typecheck.blocking ? '' : ', not blocking';
      lines.push(`typecheck: ${problems.length} problem(s)${blocks}`);
      if (typecheck.blocking) blockers.push('the typecheck');
    }
    lines.push(...problems.map((problem) => `  - ${problem}`));
    lines.push(...warnings.map((warning) => `  warning: ${warning}`));
  }

  const coverageConfig = config.checks.coverage;
  if (coverageConfig === false) {
    lines.push('coverage: off');
  } else {
    const { missing, blocking } = await coverage(suites, coverageConfig, config.root);
    if (missing.length === 0) {
      lines.push('coverage: every API name is mentioned');
    } else {
      lines.push(
        `coverage: ${missing.length} API name(s) not mentioned in any SKILL.md or eval file` +
          `${blocking ? '' : ', not blocking'}: ${missing.join(', ')}`,
      );
      if (blocking) blockers.push('the coverage');
    }
  }
  return { lines, blockers };
}

/**
 * Printed once by `run`, before the first skill with code tests, and by `triage` before it
 * prepares them.
 */
const SANDBOX_NOTE =
  "note: code tests run the model's code on this machine, in a separate process without your " +
  "environment's secrets. It is not a sandbox (see https://github.com/ngwes/skill-be/issues/20).";

function hasContracts(suite: SkillSuite): boolean {
  return suite.scenarios.some((scenario) => scenario.output !== null);
}

/**
 * The hint-word warnings of the output contracts of `suites`, against the coverage check's API
 * names when coverage is configured, else against each skill's own code. None, and no API listed,
 * when no suite has a contract.
 */
async function hintWarnings(config: Config, suites: SkillSuite[]): Promise<string[]> {
  const contracted = suites.filter(hasContracts);
  if (contracted.length === 0) return [];
  const coverageConfig = config.checks.coverage;
  const vocabulary = coverageConfig === false ? null : await apiWords(coverageConfig, config.root);
  return contracted.flatMap((suite) => contractHints(suite, vocabulary, config.codeTests.allow));
}

/**
 * Parses every TypeScript file of the code tests of `suites` (test files and helpers), without
 * running or installing anything: a syntax error blocks. No line at all when no suite has a
 * contract.
 */
async function parseCodeTests(
  config: Config,
  suites: SkillSuite[],
  show: (file: string) => string,
): Promise<ChecksOutcome> {
  if (!suites.some(hasContracts)) return { lines: [], blockers: [] };
  const ts = await loadTypescript('code tests', config.root, {});
  const files = [...new Set(suites.flatMap((suite) => suite.codeFiles))].filter((file) =>
    file.endsWith('.ts'),
  );
  const problems: string[] = [];
  for (const file of files) {
    const errors = syntaxErrors(ts, await readFile(file, 'utf8'), file);
    problems.push(...errors.map(({ line, message }) => `${show(file)}:${line}: ${message}`));
  }
  if (problems.length === 0) {
    return { lines: [`code tests: ${files.length} test file(s) parse`], blockers: [] };
  }
  return {
    lines: [
      `code tests: ${problems.length} syntax error(s)`,
      ...problems.map((problem) => `  - ${problem}`),
    ],
    blockers: ['the code tests'],
  };
}

/** The last line of a command's output, and its exit code. */
function conclude(ctx: Context, blockers: string[]): number {
  ctx.out(blockers.length === 0 ? 'Result: pass' : `Result: blocked by ${blockers.join(', ')}`);
  return blockers.length === 0 ? 0 : 1;
}

async function runCommand(args: Args, ctx: Context): Promise<number> {
  const reps = positiveInteger(args, 'reps');
  const concurrency = positiveInteger(args, 'concurrency');
  const project = await loadProject(args, ctx);
  const config: Config = {
    ...project.config,
    reps: reps.orElse(project.config.reps),
    concurrency: concurrency.orElse(project.config.concurrency),
  };

  // Before the first model call: a broken result file or check setting must not cost a run.
  const existing = await readResultFile(config.resultFile);
  await validateChecks(config);
  for (const warning of await hintWarnings(config, project.selected)) ctx.err(`warning: ${warning}`);
  // So is a code test that cannot be installed, compiled or listed.
  const preparing = prepareCodeTests(config, project.selected, {
    keepDeps: args.flags.has('keep-deps'),
    log: ctx.err,
  });
  return withCleanup(
    () => disposeCodeTests(preparing),
    async () => benchmark(args, ctx, { config, all: project.all, existing }, await preparing),
  );
}

/** Disposes of the code tests once they are prepared; a preparation that failed cleaned up. */
async function disposeCodeTests(preparing: Promise<CodeTests> | null): Promise<void> {
  const codeTests = await preparing?.catch(() => null);
  await codeTests?.dispose();
}

/**
 * Cleanups of the commands in flight, which the entry point awaits before it exits on a signal.
 * Each returns the same promise however often it is called.
 */
const pendingCleanups = new Set<() => Promise<void>>();

/**
 * Runs `work`, then `cleanUp` once, whether `work` succeeds or throws. The entry point also runs
 * `cleanUp` when it stops on a signal while `work` is in flight.
 */
async function withCleanup<T>(cleanUp: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  let cleaning: Promise<void> | undefined;
  const once = (): Promise<void> => (cleaning ??= cleanUp());
  pendingCleanups.add(once);
  try {
    return await work();
  } finally {
    await once().finally(() => pendingCleanups.delete(once));
  }
}

/**
 * Runs the selected skills with their prepared code tests, writes the reports, the summary and
 * the result file after each, then runs the checks.
 */
async function benchmark(
  args: Args,
  ctx: Context,
  project: { config: Config; all: SkillSuite[]; existing: ResultFile | null },
  codeTests: CodeTests,
): Promise<number> {
  const { config, existing } = project;
  const suites = codeTests.suites;
  const version = await skillBeVersion();
  // The files as the run reads them, before a long run gives anyone time to edit them.
  const fingerprints = await Promise.all(suites.map((suite) => skillFingerprint(config, suite)));

  const timestamp = resultsTimestamp();
  const runDir = path.join(config.results, timestamp);
  const summaryPath = path.join(runDir, 'summary.json');
  const htmlPath = Option.from(args.flags.has('html') ? path.join(runDir, 'results.html') : null);
  const runs: SkillRun[] = [];
  const gates = new Map<string, GateVerdict>();
  const entries: Record<string, SkillEntry> = {};
  const reports: string[] = [];

  let noted = false;
  for (const [i, suite] of suites.entries()) {
    if (!noted && hasContracts(suite)) {
      ctx.err(SANDBOX_NOTE);
      noted = true;
    }
    const run = await runSkill(suite, config, { log: ctx.err, timestamp, codeTests });
    // A run stopped on a signal ends with killed calls: its scores must not reach any file.
    ctx.throwIfStopped();
    const gate = evaluateGate(run, config.gate);
    runs.push(run);
    gates.set(run.skill, gate);
    const date = run.startedAt.slice(0, 10);

    const report = renderReport(run, gate, {
      models: config.models,
      grader: config.grader,
      reps: config.reps,
      gradings: config.gradings,
      date,
    });
    const reportPath = path.join(runDir, `${suite.name}.md`);
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, report);
    reports.push(reportPath);
    ctx.write(report);

    // Written after every skill, so an interrupted run keeps what it finished.
    await writeFile(summaryPath, JSON.stringify(toSummary(runs, gates), null, 2) + '\n');
    await htmlPath.matchAsync(
      (file) =>
        writeFile(
          file,
          renderHtml(runs, gates, {
            models: config.models,
            grader: config.grader,
            reps: config.reps,
            gradings: config.gradings,
            // The day the run started: its first skill's.
            date: (runs[0] as SkillRun).startedAt.slice(0, 10),
          }),
        ),
      async () => {},
    );
    entries[suite.name] = {
      date,
      fingerprint: fingerprints[i] as string,
      ready: gate.ready,
      reasons: gate.reasons,
      models: modelLabels(config.models),
      grader: config.grader.id,
    };
    await writeResultFile(
      config.resultFile,
      mergeResults(existing, { skillBeVersion: version, skills: entries }),
    );
  }

  const checks = await runChecks(config, project.all);

  ctx.out('Skills:');
  for (const run of runs) {
    const gate = gates.get(run.skill) as GateVerdict;
    const reasons = gate.reasons.length;
    ctx.out(`  ${run.skill}: ${gate.ready ? 'READY' : `NOT READY (${reasons} reason(s))`}`);
  }
  for (const line of checks.lines) ctx.out(line);
  ctx.out('Written:');
  const written = [
    ...reports,
    summaryPath,
    ...htmlPath.match((file) => [file], () => []),
    config.resultFile,
  ];
  for (const file of written) ctx.out(`  ${ctx.show(file)}`);

  const notReady = runs.filter((run) => !gates.get(run.skill)?.ready);
  const blockers = [
    ...notReady.map((run) => `skill "${run.skill}" NOT READY`),
    ...checks.blockers,
  ];
  return conclude(ctx, blockers);
}

async function verifyCommand(args: Args, ctx: Context): Promise<number> {
  const { config, all } = await loadProject(args, ctx);
  const file = await readResultFile(config.resultFile);
  const { ok, problems } = await verifyResults(config, all, file);
  const checks = await runChecks(config, all);

  const where = `result file ${ctx.show(config.resultFile)}`;
  ctx.out(
    ok
      ? `${where}: ${all.length} skill(s) match their last run, every one READY`
      : `${where}: ${problems.length} problem(s)`,
  );
  for (const problem of problems) ctx.out(`  - ${problem}`);
  for (const line of checks.lines) ctx.out(line);
  return conclude(ctx, [...(ok ? [] : ['the result file']), ...checks.blockers]);
}

async function checkCommand(args: Args, ctx: Context): Promise<number> {
  const { config, all } = await loadProject(args, ctx);
  for (const warning of await hintWarnings(config, all)) ctx.err(`warning: ${warning}`);
  const checks = await runChecks(config, all);
  const parsed = await parseCodeTests(config, all, ctx.show);
  for (const line of [...checks.lines, ...parsed.lines]) ctx.out(line);
  return conclude(ctx, [...checks.blockers, ...parsed.blockers]);
}

async function triageCommand(args: Args, ctx: Context): Promise<number> {
  const below = percentage(args, 'below');
  const samples = positiveInteger(args, 'samples');
  const { config, selected } = await loadProject(args, ctx);

  // Prepared only when a code test is triaged, and then disposed of the way `run` does.
  let preparing: Promise<CodeTests> | null = null;
  const options: TriageOptions = {
    deps: {
      log: ctx.err,
      prepareCodeTests: (suites) => {
        ctx.err(SANDBOX_NOTE);
        preparing = prepareCodeTests(config, suites, {
          keepDeps: args.flags.has('keep-deps'),
          log: ctx.err,
        });
        return preparing;
      },
    },
  };
  below.onSome((value) => (options.below = value));
  samples.onSome((value) => (options.samples = value));
  const { reportPath, items } = await withCleanup(
    () => disposeCodeTests(preparing),
    () => triage(config, selected, options),
  );

  ctx.out(`Triage: ${items.length} failure(s)`);
  for (const item of items) {
    ctx.out(
      `  ${item.skill} [${item.scenario}] ${item.model} "${item.criterion}": ` +
        `${item.proposed} — ${item.reason}`,
    );
  }
  ctx.out(`Report: ${ctx.show(reportPath)}`);
  return 0;
}

/** True when this module is the script node runs, also through npm's bin link. */
function isEntryPoint(): boolean {
  return Option.from(process.argv[1]).match(
    (script) =>
      Try.run(() => realpathSync(script) === realpathSync(fileURLToPath(import.meta.url)))
        .onFail(false),
    () => false,
  );
}

/** Set by the first {@link stop}. */
let stopping = false;

/**
 * Exits with `code` once the in-flight model calls are killed (they run in their own process
 * group on POSIX, so Ctrl+C does not reach them, and work a config error left queued would keep
 * starting them) and the commands in flight have cleaned up: a run or a triage removes its
 * compiled tests and, without `--keep-deps`, its installed test packages. Only the first call
 * counts: a command a signal stops still returns a code of its own afterwards.
 */
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  killActiveChildren();
  process.exitCode = code;
  void Promise.allSettled([...pendingCleanups].map((cleanUp) => cleanUp())).then(() =>
    // Let stdout and stderr flush what was written to them first.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code))),
  );
}

if (isEntryPoint()) {
  const stopped = new AbortController();
  // `once`: a second Ctrl+C exits at once, even while a cleanup hangs.
  const onSignal = (code: number) => (): void => {
    stopped.abort();
    stop(code);
  };
  process.once('SIGINT', onSignal(130));
  process.once('SIGTERM', onSignal(143));
  void main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    signal: stopped.signal,
  }).then(stop);
}
