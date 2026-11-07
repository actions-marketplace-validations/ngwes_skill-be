/**
 * The child process that runs one answer's code tests; `execute.ts` is the parent side. Node runs
 * the compiled `dist/code-tests/child.js`, with the answer's folder as its working directory.
 *
 * Protocol. The parent writes one JSON line to stdin:
 * `{ mode: 'list' | 'run', testFile, answerFile, fields, testTimeoutMs, token }`, where `token`
 * is a random string the parent picks for this run. The child prints one JSON line per event on
 * stdout, each an object whose `skillBe` key is the token, so the parent tells them from whatever
 * the test file or the answer prints (it ignores every other line):
 * - `{"skillBe":token,"loadError":"<message>"}` when the test file throws on load, in either mode;
 * - `{"skillBe":token,"names":["…"]}` in list mode, the names of the registered tests in order;
 * - `{"skillBe":token,"i":0,"pass":true,"message":""}` in run mode, one per registered test in
 *   order, `i` its index; each line is flushed before the next test starts.
 * Each line is written after a line break, so output the answer left without one cannot join it.
 * After the last line the child exits with `process.exit(0)`, whatever the answer left running
 * (the real one, taken before any test code loads, so replacing `process.exit` does not stop it).
 *
 * In run mode each test gets the answer module's exports named in `fields` (a missing one is
 * `undefined`); every test fails when the answer throws on load or has no `result` export. A test
 * fails when it throws or rejects, when it takes longer than `testTimeoutMs`, or when an uncaught
 * exception or an unhandled rejection happens while it runs (the next test still runs). A test
 * that never yields, such as an endless loop, cannot be stopped here: the parent's kill ends it.
 */

import { pathToFileURL } from 'node:url';
import { registeredTests } from '../testing.js';

type Request = {
  mode: 'list' | 'run';
  testFile: string;
  answerFile: string | null;
  fields: string[];
  testTimeoutMs: number;
  token: string;
};

type Outcome = { pass: boolean; message: string };

type Fields = Record<string, unknown>;

type TestFn = ReturnType<typeof registeredTests>[number]['fn'];

// Taken before any test code loads, which may replace `process.stdout.write` or `process.exit`.
const writeStdout = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);

/** Fails the test that is running; `null` between tests, when an uncaught error is ignored. */
let failRunning: ((error: unknown) => void) | null = null;

process.on('uncaughtException', (error) => failRunning?.(error));
process.on('unhandledRejection', (reason) => failRunning?.(reason));

const PASSED: Outcome = { pass: true, message: '' };

function failed(message: string): Outcome {
  return { pass: false, message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRequest(): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
}

/** Writes one protocol line and resolves once it is handed to the OS. */
function emit(token: string, event: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    writeStdout(`\n${JSON.stringify({ skillBe: token, ...event })}\n`, () => resolve());
  });
}

function importFile(file: string): Promise<Fields> {
  return import(pathToFileURL(file).href) as Promise<Fields>;
}

/** The fields each test gets, or the message every test fails with. */
async function answerFields(request: Request): Promise<Fields | string> {
  let answer: Fields = {};
  if (request.answerFile !== null) {
    try {
      answer = await importFile(request.answerFile);
    } catch (error) {
      return `the answer threw on load: ${messageOf(error)}`;
    }
  }
  if (!('result' in answer)) return 'the answer has no "result" export';
  return Object.fromEntries(request.fields.map((field) => [field, answer[field]]));
}

/** Runs one test to its outcome; never rejects. */
function runTest(fn: TestFn, fields: Fields, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      failRunning = null;
      resolve(outcome);
    };
    const timer = setTimeout(() => settle(failed(`timed out after ${timeoutMs} ms`)), timeoutMs);
    failRunning = (error) => settle(failed(messageOf(error)));
    Promise.resolve()
      .then(() => fn({ ...fields }))
      .then(
        // Node reports a rejection the test left unhandled once the microtasks have run: wait
        // for the next turn of the event loop, so that it still fails this test.
        () => setImmediate(() => settle(PASSED)),
        (error: unknown) => settle(failed(messageOf(error))),
      );
  });
}

async function main(): Promise<void> {
  const request = await readRequest();
  try {
    await importFile(request.testFile);
  } catch (error) {
    await emit(request.token, { loadError: messageOf(error) });
    return;
  }
  const tests = registeredTests();
  if (request.mode === 'list') {
    await emit(request.token, { names: tests.map((registered) => registered.name) });
    return;
  }
  const fields = await answerFields(request);
  for (const [i, registered] of tests.entries()) {
    const outcome =
      typeof fields === 'string'
        ? failed(fields)
        : await runTest(registered.fn, fields, request.testTimeoutMs);
    await emit(request.token, { i, ...outcome });
  }
}

main().then(
  () => exit(0),
  (error: unknown) => {
    process.stderr.write(`skill-be child: ${messageOf(error)}\n`);
    exit(1);
  },
);
