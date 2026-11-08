/**
 * The libraries the code of an answer may import. They come from a package list: the list is read
 * from a file, and installed once into a folder of its own under `<root>/.skill-be/deps/`, which
 * the answers and the test files run in, so Node looks there first. That folder is inside the
 * project, so a package that is not listed can still resolve from the project's own
 * `node_modules` (or a folder above it): nothing here prevents it.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * How skill-be removes a folder it made: a folder that is already gone is fine, and a removal that
 * fails because Windows still holds a file of it (a child that just exited) is tried again.
 */
export const REMOVE_FOLDER = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/** The prefix of an npm spec that names a local folder or tarball by its path. */
const FILE_PREFIX = 'file:';

/** The prefix of a `file:` spec that is a URL (`file:///D:/libs/pkg`), not a path. */
const FILE_URL_PREFIX = 'file://';

/**
 * The npm specs of a package list: a JSON file `{ "npm": [ ...specs ] }`. A spec that is a local
 * path (it starts with `.` or `/`, or with a drive letter) is made absolute against the folder of
 * the list, and so is the path of a `file:` spec, which keeps its prefix (`file:../lib` becomes
 * `file:/abs/lib`); every other spec is returned as written, a `file://` URL included.
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
 * The folder {@link installPackages} installs `specs` into, `<root>/.skill-be/deps/<hash>/`, where
 * the hash is taken over the specs: a caller can plan to remove it before the install starts.
 */
export function installFolder(specs: string[], root: string): string {
  return path.resolve(root, '.skill-be', 'deps', hashOf(specs).slice(0, 16));
}

/**
 * Installs `specs` into their {@link installFolder}. A folder whose marker holds the same hash is
 * reused without running npm; any other folder there, such as one an install left half done, is
 * removed first. An empty list still gets its folder, with its `package.json` and marker, but npm
 * does not run. The project's `<root>/.npmrc`, when there is one, is copied into the folder for
 * npm to read (it is not part of the hash).
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
  const hash = hashOf(specs);
  const dir = installFolder(specs, root);
  const marker = path.join(dir, MARKER);

  if ((await markerOf(marker)) === hash) return { dir, reused: true };

  await TryAsync.runAsync(async () => {
    await rm(dir, REMOVE_FOLDER);
    await mkdir(dir, { recursive: true });
    const manifest = { private: true, type: 'module' };
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    // npm reads the project's config from the folder it installs in: this one, not the project.
    if (specs.length > 0) await copyNpmrc(root, dir);
  }).onFail((error) => {
    throw new ConfigError(`cannot prepare ${dir} (${(error as Error).message})`);
  });
  if (specs.length > 0) await npmInstall(specs, dir, run);
  await writeFile(marker, hash);
  return { dir, reused: false };
}

/** Deletes an install folder with everything in it; a folder that is already gone is fine. */
export function removePackages(dir: string): Promise<void> {
  return rm(dir, REMOVE_FOLDER);
}

function hashOf(specs: string[]): string {
  return createHash('sha256').update(specs.join('\n')).digest('hex');
}

/** Copies `<root>/.npmrc` into `dir`; nothing to do when the project has none. */
async function copyNpmrc(root: string, dir: string): Promise<void> {
  await TryAsync.runAsync(() =>
    copyFile(path.join(root, '.npmrc'), path.join(dir, '.npmrc')),
  ).onFail((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
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
    .map((specs) => specs.map((spec) => absoluteSpec(spec, base)));
}

/**
 * A local path or a `file:` path spec made absolute against `base` (a `file:` spec keeps its
 * prefix), else the spec as it is. npm would resolve the paths against the install folder. A
 * `file://` URL is already absolute and is left alone: read as a path, `file:///D:/libs/pkg`
 * would become a nonsense path on Windows.
 */
function absoluteSpec(spec: string, base: string): string {
  if (spec.startsWith(FILE_URL_PREFIX)) return spec;
  if (spec.startsWith(FILE_PREFIX)) {
    return `${FILE_PREFIX}${path.resolve(base, spec.slice(FILE_PREFIX.length))}`;
  }
  return isLocalPath(spec) ? path.resolve(base, spec) : spec;
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
