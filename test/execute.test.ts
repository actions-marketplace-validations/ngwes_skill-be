import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  childEnv,
  executeTests,
  listTests,
  type ExecuteOptions,
} from '../src/code-tests/execute.js';
import { ConfigError } from '../src/types.js';

// The built wrapper, which the child loads too: global-setup.ts builds dist/ before the run.
const TESTING_URL = pathToFileURL(
  fileURLToPath(new URL('../dist/testing.js', import.meta.url)),
).href;
// Each case starts a child or two; room for that on a slow machine.
const CHILD_TEST = { timeout: 20_000 };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-execute-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Writes a test file that imports the wrapper as `test` and has `body` after the import. */
async function testFile(body: string, testingUrl = TESTING_URL): Promise<string> {
  const file = path.join(dir, 'case.test.js');
  await writeFile(file, `import { test } from ${JSON.stringify(testingUrl)};\n${body}\n`);
  return file;
}

async function answerFile(code: string): Promise<string> {
  const file = path.join(dir, 'answer.js');
  await writeFile(file, code);
  return file;
}

function options(
  test: string,
  answer: string | null,
  overrides: Partial<ExecuteOptions> = {},
): ExecuteOptions {
  return {
    testFile: test,
    answerFile: answer,
    fields: ['result'],
    testTimeoutMs: 2000,
    answerTimeoutMs: 10_000,
    cwd: dir,
    ...overrides,
  };
}

const PASS = { pass: true, message: '' };

describe('listTests', () => {
  it('lists the registered test names', CHILD_TEST, async () => {
    const test = await testFile(`test('first', () => {});\ntest('second', async () => {});`);
    expect(await listTests(options(test, null))).toEqual(['first', 'second']);
  });

  it(
    'listTests throws a ConfigError naming the file when the test file throws on load',
    CHILD_TEST,
    async () => {
      const test = await testFile(`throw new Error('broken helper');`);
      const listing = listTests(options(test, null));
      await expect(listing).rejects.toThrow(ConfigError);
      await expect(listing).rejects.toThrow(test);
      await expect(listing).rejects.toThrow('broken helper');
    },
  );

  it(
    'registers through a differently spelled URL of the wrapper',
    CHILD_TEST,
    async () => {
      // Node loads `?x=1` as a module instance of its own; the registry must still be shared.
      const test = await testFile(`test('spelled', () => {});`, `${TESTING_URL}?x=1`);
      expect(await listTests(options(test, null))).toEqual(['spelled']);
    },
  );

  it('ignores what the test file prints to stdout', CHILD_TEST, async () => {
    const test = await testFile(
      [
        `console.log('{"names":["forged"]}');`,
        `console.log('not json');`,
        `process.stdout.write('no newline');`,
        `test('real', () => {});`,
      ].join('\n'),
    );
    expect(await listTests(options(test, null))).toEqual(['real']);
  });
});

describe('childEnv', () => {
  const env = {
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    Path: 'C:\\bin',
    temp: 'C:\\tmp',
    ANTHROPIC_API_KEY: 'sk-secret',
    path_extra: 'not a path',
  };

  it('matches the allowed names in any case on Windows', () => {
    expect(childEnv(env, 'win32')).toEqual({
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      Path: 'C:\\bin',
      temp: 'C:\\tmp',
    });
  });

  it('matches the allowed names exactly elsewhere', () => {
    expect(childEnv({ ...env, PATH: '/bin', HOME: '/home/me' }, 'linux')).toEqual({
      Path: 'C:\\bin',
      PATH: '/bin',
      HOME: '/home/me',
    });
  });
});

describe('executeTests', () => {
  it('passes and fails tests and keeps their messages', CHILD_TEST, async () => {
    const test = await testFile(
      [
        `test('adds', ({ result }) => { if (result(1, 2) !== 3) throw new Error('not 3'); });`,
        `test('wrong', ({ result }) => {`,
        `  if (result(2, 2) !== 5) throw new Error('expected 5, got ' + result(2, 2));`,
        `});`,
        `test('async fail', async () => { await null; throw new Error('later'); });`,
        `test('prints', ({ result }) => { console.log('{"i":0}'); result(0, 0); });`,
      ].join('\n'),
    );
    const answer = await answerFile('export const result = (a, b) => a + b;\n');
    const names = ['adds', 'wrong', 'async fail', 'prints'];
    expect(await executeTests(options(test, answer), names)).toEqual({
      outcomes: [
        { name: 'adds', ...PASS },
        { name: 'wrong', pass: false, message: 'expected 5, got 4' },
        { name: 'async fail', pass: false, message: 'later' },
        { name: 'prints', ...PASS },
      ],
      infraError: null,
    });
  });

  it('hands the contract fields to each test', CHILD_TEST, async () => {
    const test = await testFile(
      [
        `test('fields', (fields) => {`,
        `  const seen = JSON.stringify(Object.keys(fields).sort());`,
        `  if (seen !== '["helper","missing","result"]') throw new Error(seen);`,
        `  if (fields.result !== 1) throw new Error('result');`,
        `  if (fields.helper() !== 'h') throw new Error('helper');`,
        `  if (fields.missing !== undefined) throw new Error('missing');`,
        `});`,
      ].join('\n'),
    );
    const answer = await answerFile(
      [
        'export const result = 1;',
        "export function helper() { return 'h'; }",
        'export const notInTheContract = 2;',
      ].join('\n'),
    );
    const fields = ['result', 'helper', 'missing'];
    expect(await executeTests(options(test, answer, { fields }), ['fields'])).toEqual({
      outcomes: [{ name: 'fields', ...PASS }],
      infraError: null,
    });
  });

  it('fails every test when the answer has no result export', CHILD_TEST, async () => {
    const test = await testFile(`test('a', () => {});\ntest('b', () => {});`);
    const answer = await answerFile('export const other = 1;\n');
    const message = 'the answer has no "result" export';
    expect(await executeTests(options(test, answer), ['a', 'b'])).toEqual({
      outcomes: [
        { name: 'a', pass: false, message },
        { name: 'b', pass: false, message },
      ],
      infraError: null,
    });
  });

  it('fails every test when the answer throws on load', CHILD_TEST, async () => {
    const test = await testFile(`test('a', () => {});\ntest('b', () => {});`);
    const answer = await answerFile("throw new Error('bad answer');\nexport const result = 1;\n");
    const message = 'the answer threw on load: bad answer';
    expect(await executeTests(options(test, answer), ['a', 'b'])).toEqual({
      outcomes: [
        { name: 'a', pass: false, message },
        { name: 'b', pass: false, message },
      ],
      infraError: null,
    });
  });

  it('times out a slow test and runs the next', CHILD_TEST, async () => {
    const test = await testFile(
      `test('slow', () => new Promise(() => {}));\ntest('quick', () => {});`,
    );
    const answer = await answerFile('export const result = 1;\n');
    const opts = options(test, answer, { testTimeoutMs: 300 });
    expect(await executeTests(opts, ['slow', 'quick'])).toEqual({
      outcomes: [
        { name: 'slow', pass: false, message: 'timed out after 300 ms' },
        { name: 'quick', ...PASS },
      ],
      infraError: null,
    });
  });

  it(
    'exits after the last test even when the answer keeps the event loop busy',
    CHILD_TEST,
    async () => {
      const test = await testFile(`test('a', () => {});`);
      const answer = await answerFile('setInterval(() => {}, 1000);\nexport const result = 1;\n');
      const started = Date.now();
      const run = await executeTests(options(test, answer, { answerTimeoutMs: 15_000 }), ['a']);
      expect(run).toEqual({ outcomes: [{ name: 'a', ...PASS }], infraError: null });
      // Waiting for the event loop would end only at the 15 s kill.
      expect(Date.now() - started).toBeLessThan(10_000);
    },
  );

  it('an unhandled rejection fails the running test only', CHILD_TEST, async () => {
    const test = await testFile(
      [
        `test('rejects', async () => {`,
        `  Promise.reject(new Error('stray'));`,
        `  await new Promise((resolve) => setTimeout(resolve, 200));`,
        `});`,
        `test('throws later', async () => {`,
        `  setTimeout(() => { throw new Error('uncaught'); }, 0);`,
        `  await new Promise((resolve) => setTimeout(resolve, 200));`,
        `});`,
        `test('after', () => {});`,
      ].join('\n'),
    );
    const answer = await answerFile('export const result = 1;\n');
    expect(await executeTests(options(test, answer), ['rejects', 'throws later', 'after'])).toEqual(
      {
        outcomes: [
          { name: 'rejects', pass: false, message: 'stray' },
          { name: 'throws later', pass: false, message: 'uncaught' },
          { name: 'after', ...PASS },
        ],
        infraError: null,
      },
    );
  });

  it('keeps the results reported before the process died', CHILD_TEST, async () => {
    const test = await testFile(
      [
        `test('one', () => {});`,
        `test('two', ({ result }) => result());`,
        `test('three', () => {});`,
      ].join('\n'),
    );
    const answer = await answerFile('export const result = () => process.exit(1);\n');
    const { outcomes, infraError } = await executeTests(options(test, answer), [
      'one',
      'two',
      'three',
    ]);
    expect(infraError).toBeNull();
    expect(outcomes[0]).toEqual({ name: 'one', ...PASS });
    for (const [index, name] of [
      [1, 'two'],
      [2, 'three'],
    ] as const) {
      expect(outcomes[index]).toEqual({
        name,
        pass: false,
        message: 'the process ended before this test ran (exited with code 1)',
      });
    }
  });

  it('ends an endless loop at the answer timeout', CHILD_TEST, async () => {
    const test = await testFile(
      `test('ok', () => {});\ntest('loops', () => { for (;;) {} });\ntest('never', () => {});`,
    );
    const answer = await answerFile('export const result = 1;\n');
    const opts = options(test, answer, { answerTimeoutMs: 1500 });
    const ended = 'the process ended before this test ran (timed out after 1500 ms)';
    expect(await executeTests(opts, ['ok', 'loops', 'never'])).toEqual({
      outcomes: [
        { name: 'ok', ...PASS },
        { name: 'loops', pass: false, message: ended },
        { name: 'never', pass: false, message: ended },
      ],
      infraError: null,
    });
  });

  it('strips every variable outside the allow-list', CHILD_TEST, async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=64');
    const test = await testFile(
      [
        `test('no key', () => {`,
        `  if (process.env.ANTHROPIC_API_KEY !== undefined) throw new Error('key leaked');`,
        `  if (process.env.NODE_OPTIONS !== undefined) throw new Error('NODE_OPTIONS leaked');`,
        `});`,
        `test('path kept', () => {`,
        `  if ((process.env.PATH ?? process.env.Path) === undefined) throw new Error('no PATH');`,
        `});`,
      ].join('\n'),
    );
    const answer = await answerFile('export const result = 1;\n');
    expect(await executeTests(options(test, answer), ['no key', 'path kept'])).toEqual({
      outcomes: [
        { name: 'no key', ...PASS },
        { name: 'path kept', ...PASS },
      ],
      infraError: null,
    });
  });

  it('exits after the last test though the answer replaced process.exit', CHILD_TEST, async () => {
    const test = await testFile(`test('one', () => {});`);
    // Without the real exit, the interval would keep the child up until the answer timeout.
    const answer = await answerFile(
      'process.exit = () => {};\nsetInterval(() => {}, 1000);\nexport const result = 1;\n',
    );
    const started = Date.now();
    const run = await executeTests(options(test, answer, { answerTimeoutMs: 15_000 }), ['one']);
    expect(run).toEqual({ outcomes: [{ name: 'one', ...PASS }], infraError: null });
    expect(Date.now() - started).toBeLessThan(7_500);
  });

  it('reports an infra error when the test file throws on load', CHILD_TEST, async () => {
    const test = await testFile(`throw new Error('broken helper');`);
    const answer = await answerFile('export const result = 1;\n');
    const { outcomes, infraError } = await executeTests(options(test, answer), ['a']);
    expect(infraError).toContain(test);
    expect(infraError).toContain('broken helper');
    expect(outcomes).toEqual([{ name: 'a', pass: false, message: infraError }]);
  });
});
