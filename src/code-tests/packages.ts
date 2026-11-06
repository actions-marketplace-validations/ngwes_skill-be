/**
 * The libraries the code of an answer may import. They come from a package list, never from the
 * project's own `node_modules`: the list is read from a file, and installed once into a folder of
 * its own under `<root>/.skill-be/deps/`, which the answers and the test files run in.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Try, TryAsync, sequenceValidate, type Either } from '@ngwes/mini-fp';
import type { Runner } from '../adapters/common.js';
import { check, fail, firstProblem, pass, valueOrThrow, type Checked } from '../checked.js';
import { runProcess, type ProcessResult } from '../process.js';
import { ConfigError } from '../types.js';

/** Where the other languages' package lists are tracked. */
const LANGUAGES_ISSUE = 'https://github.com/ngwes/skill-be/issues/32';

/** Written in an install folder once its packages are installed; holds the hash of the specs. */
const MARKER = '.skill-be-installed';

/** The most an `npm install` may take: it may download a whole dependency tree. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of npm's output an error message keeps, from the end. */
const DETAIL_LENGTH = 1000;

/**
 * The npm specs of a package list: a JSON file `{ "npm": [ ...specs ] }`. A spec that is a local
 * path (it starts with `.` or `/`, or with a drive letter) is made absolute against the folder of
 * the list; every other spec is returned as written.
 *
 * @throws ConfigError when the file is missing, unreadable or not a package list, or when it has
 * a section for a language other than npm.
 */
export async function readPackageList(file: string): Promise<string[]> {
  const text = await textOf(file);
  return valueOrThrow(
    parseList(text, path.dirname(file)).mapLeft((message) => `${file}: ${message}`),
  );
}

/**
 * Installs `specs` into `<root>/.skill-be/deps/<hash>/`, where the hash is taken over the specs.
 * A folder whose marker holds the same hash is reused without running npm. An empty list still
 * gets its folder, with its `package.json` and marker, but npm does not run.
 *
 * @param run starts npm; `runProcess` unless a test passes a fake.
 * @throws ConfigError when npm cannot start, times out or fails; its message ends with what npm
 * printed.
 */
export async function installPackages(
  specs: string[],
  root: string,
  run: Runner = runProcess,
): Promise<{ dir: string; reused: boolean }> {
  const hash = createHash('sha256').update(specs.join('\n')).digest('hex');
  const dir = path.resolve(root, '.skill-be', 'deps', hash.slice(0, 16));
  const marker = path.join(dir, MARKER);

  if ((await markerOf(marker)) === hash) return { dir, reused: true };

  await TryAsync.runAsync(async () => {
    await mkdir(dir, { recursive: true });
    // A marker of another list must not survive an install that fails half way.
    await rm(marker, { force: true });
    const manifest = { private: true, type: 'module' };
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  }).onFail((error) => {
    throw new ConfigError(`cannot prepare ${dir} (${(error as Error).message})`);
  });
  if (specs.length > 0) await npmInstall(specs, dir, run);
  await writeFile(marker, hash);
  return { dir, reused: false };
}

/** Deletes an install folder with everything in it; a folder that is already gone is fine. */
export function removePackages(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

/** The text of a package list, without a byte order mark. */
function textOf(file: string): Promise<string> {
  return TryAsync.runAsync(() => readFile(file, 'utf8')).match(
    (text) => text.replace(/^﻿/, ''),
    (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new ConfigError(`${file}: the package list does not exist`);
      }
      throw new ConfigError(`${file}: cannot read the package list (${(error as Error).message})`);
    },
  );
}

/** The specs of the list, local paths made absolute against `base`; else the first problem. */
function parseList(text: string, base: string): Either<string, string[]> {
  return Try.run(() => JSON.parse(text) as unknown)
    .toEither()
    .mapLeft((error) => `invalid JSON (${(error as Error).message})`)
    .bind((data) => firstProblem(specsOf(data)))
    .map((specs) => specs.map((spec) => (isLocalPath(spec) ? path.resolve(base, spec) : spec)));
}

function specsOf(data: unknown): Checked<string[]> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('the list must be an object like { "npm": ["pkg@1"] }');
  }
  const sections = data as Record<string, unknown>;
  const unsupported = Object.keys(sections).map((language) =>
    check(
      language === 'npm',
      language,
      () => `"${language}" packages are not supported yet (see ${LANGUAGES_ISSUE})`,
    ),
  );
  return sequenceValidate(unsupported).bind(() => npmSpecs(sections.npm));
}

function npmSpecs(value: unknown): Checked<string[]> {
  if (value === undefined) return pass([]);
  return check(
    Array.isArray(value) && value.every((spec) => typeof spec === 'string' && spec.trim() !== ''),
    value as string[],
    () => '"npm" must be a list of package specs (strings)',
  );
}

/** A spec that names a folder or a file on this machine, not a package of a registry. */
function isLocalPath(spec: string): boolean {
  return /^[./]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
}

/** The hash a marker file holds; null when there is no marker or it cannot be read. */
function markerOf(marker: string): Promise<string | null> {
  return TryAsync.runAsync(() => readFile(marker, 'utf8')).match<string | null>(
    (text) => text.trim(),
    () => null,
  );
}

/** Runs `npm install` of the specs in `dir`. */
async function npmInstall(specs: string[], dir: string, run: Runner): Promise<void> {
  const result = await TryAsync.runAsync(() =>
    run({
      bin: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--no-package-lock', ...specs],
      stdin: '',
      timeoutMs: INSTALL_TIMEOUT_MS,
      cwd: dir,
    }),
  ).onFail((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    // On Windows npm runs through cmd.exe, which cannot carry a percent sign or a line break.
    const culprit = specs.find((spec) => /[%\r\n]/.test(spec));
    throw new ConfigError(
      culprit === undefined
        ? `cannot install the test packages: ${reason}`
        : `cannot install the test package "${culprit}": ${reason}`,
    );
  });

  if (result.timedOut) {
    throw new ConfigError(
      `npm install of the test packages timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes`,
    );
  }
  if (result.code !== 0) {
    const how = result.code === null ? 'killed' : `exit code ${result.code}`;
    throw new ConfigError(`npm install of the test packages failed (${how})${tail(result)}`);
  }
}

/** The end of npm's output after a colon and a line break; empty when npm printed nothing. */
function tail({ stderr, stdout }: ProcessResult): string {
  const output = stderr.trim() || stdout.trim();
  if (output === '') return '';
  return `:\n${output.length > DETAIL_LENGTH ? `…${output.slice(-DETAIL_LENGTH)}` : output}`;
}
