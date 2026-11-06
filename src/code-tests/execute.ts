/**
 * Runs the code tests of one answer in a child process (the child is `child.ts`, which documents
 * the protocol): a test that hangs, crashes or exits cannot take skill-be down, and the child sees
 * none of skill-be's environment beyond what Node and the OS need.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Option, Try, TryAsync } from '@ngwes/mini-fp';
import { runProcess, type ProcessResult } from '../process.js';
import { ConfigError } from '../types.js';

export type TestOutcome = { name: string; pass: boolean; message: string };

export type ExecuteOptions = {
  /** Compiled test file (.js). */
  testFile: string;
  /** Compiled answer (.js); null in list mode. */
  answerFile: string | null;
  fields: string[];
  testTimeoutMs: number;
  answerTimeoutMs: number;
  cwd: string;
};

/**
 * The compiled child. `src/` and `dist/` both sit one level under the package root, so this
 * resolves to the same file from the source (under vitest) and from the build.
 */
const CHILD = fileURLToPath(new URL('../../dist/code-tests/child.js', import.meta.url));

/** The only variables the child gets: what Node and the OS need to start a process. */
const CHILD_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
];

type ChildEvent =
  | { kind: 'loadError'; message: string }
  | { kind: 'names'; names: string[] }
  | { kind: 'outcome'; i: number; pass: boolean; message: string };

type ChildRun = { events: ChildEvent[]; result: ProcessResult };

/**
 * Names of the tests the file registers.
 *
 * @throws ConfigError when the file throws on load, or when the child ends before it lists them.
 */
export async function listTests(
  opts: Omit<ExecuteOptions, 'answerFile' | 'fields'>,
): Promise<string[]> {
  const { events, result } = await runChild({ ...opts, answerFile: null, fields: [] }, 'list');
  for (const event of events) {
    if (event.kind === 'loadError') throw new ConfigError(loadErrorMessage(opts.testFile, event));
    if (event.kind === 'names') return event.names;
  }
  throw new ConfigError(
    `the test file ${opts.testFile} did not list its tests: ` +
      `the process ended (${endReason(result, opts.answerTimeoutMs)})${stderrTail(result)}`,
  );
}

/**
 * One outcome per listed test, in order; tests the child never reached fail with why. Every
 * failure the answer causes is a failed test; `infraError` is set, and every test fails with it,
 * only when the child cannot start or the test file throws on load.
 */
export async function executeTests(
  opts: ExecuteOptions,
  names: string[],
): Promise<{ outcomes: TestOutcome[]; infraError: string | null }> {
  const everyTestFails = (infraError: string) => ({
    outcomes: names.map((name) => ({ name, pass: false, message: infraError })),
    infraError,
  });
  return TryAsync.runAsync(() => runChild(opts, 'run')).match(
    ({ events, result }) => {
      const loadError = events.find((event) => event.kind === 'loadError');
      if (loadError !== undefined) {
        return everyTestFails(loadErrorMessage(opts.testFile, loadError));
      }
      const reported = new Map(
        events.flatMap((event) => (event.kind === 'outcome' ? [[event.i, event] as const] : [])),
      );
      const reason = endReason(result, opts.answerTimeoutMs);
      const ended = `the process ended before this test ran (${reason})`;
      const outcomes = names.map((name, i) =>
        Option.from(reported.get(i)).match<TestOutcome>(
          (event) => ({ name, pass: event.pass, message: event.message }),
          () => ({ name, pass: false, message: ended }),
        ),
      );
      return { outcomes, infraError: null };
    },
    (error) => everyTestFails(error instanceof Error ? error.message : String(error)),
  );
}

/** Runs the child in `mode`; rejects only when it cannot start. */
async function runChild(opts: ExecuteOptions, mode: 'list' | 'run'): Promise<ChildRun> {
  const token = randomUUID();
  const request = {
    mode,
    testFile: opts.testFile,
    answerFile: opts.answerFile,
    fields: opts.fields,
    testTimeoutMs: opts.testTimeoutMs,
    token,
  };
  const result = await runProcess({
    bin: process.execPath,
    args: [CHILD],
    stdin: `${JSON.stringify(request)}\n`,
    timeoutMs: opts.answerTimeoutMs,
    cwd: opts.cwd,
    env: childEnv(),
  });
  return { events: childEvents(result.stdout, token), result };
}

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => CHILD_ENV.includes(name) && value !== undefined,
    ),
  );
}

/** The protocol lines of `stdout`, in order; every other line is the test code's output. */
function childEvents(stdout: string, token: string): ChildEvent[] {
  return stdout.split(/\r?\n/).flatMap((line) =>
    Try.run(() => JSON.parse(line) as unknown).match(
      (parsed) => Option.from(eventOf(parsed, token)).match((event) => [event], () => []),
      () => [],
    ),
  );
}

function eventOf(parsed: unknown, token: string): ChildEvent | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const line = parsed as Record<string, unknown>;
  if (line.skillBe !== token) return undefined;
  if (typeof line.loadError === 'string') return { kind: 'loadError', message: line.loadError };
  if (Array.isArray(line.names) && line.names.every((name) => typeof name === 'string')) {
    return { kind: 'names', names: line.names as string[] };
  }
  if (
    typeof line.i === 'number' &&
    typeof line.pass === 'boolean' &&
    typeof line.message === 'string'
  ) {
    return { kind: 'outcome', i: line.i, pass: line.pass, message: line.message };
  }
  return undefined;
}

function loadErrorMessage(testFile: string, event: { message: string }): string {
  return `the test file ${testFile} threw on load: ${event.message}`;
}

/** Why the child ended, for the tests it never reached. */
function endReason(result: ProcessResult, answerTimeoutMs: number): string {
  if (result.timedOut) return `timed out after ${answerTimeoutMs} ms`;
  return result.code === null ? 'killed' : `exited with code ${result.code}`;
}

/** The last line the child wrote to stderr, after a colon; empty when it wrote nothing. */
function stderrTail(result: ProcessResult): string {
  const lines = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  return Option.from(lines[lines.length - 1]).match(
    (line) => `: ${line.trim()}`,
    () => '',
  );
}
