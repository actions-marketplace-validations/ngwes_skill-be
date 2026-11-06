/**
 * The wrapper a code test is written with, `@ngwes/skill-be/testing`: `test(name, fn)` registers a
 * test, and skill-be runs the registered tests against the fields the model's code exports.
 *
 * ```ts
 * import { test } from '@ngwes/skill-be/testing';
 *
 * test('adds', ({ result }) => {
 *   if (result(1, 2) !== 3) throw new Error('expected 3');
 * });
 * ```
 */

export type TestFn<F> = (fields: F) => void | Promise<void>;

type Registered = { name: string; fn: TestFn<Record<string, unknown>> };

/**
 * The registry is on `globalThis`, not in the module: skill-be's runner and the compiled test
 * file may each load their own copy of this module, and both must see one list.
 */
const REGISTRY = Symbol.for('skill-be.tests');

function registry(): Registered[] {
  const holder = globalThis as { [REGISTRY]?: Registered[] };
  return (holder[REGISTRY] ??= []);
}

/**
 * Registers a test. Its function gets the fields the answer exports, by the names of the
 * scenario's `output` contract, and fails by throwing (an assertion library works as it is).
 *
 * @throws Error when a test with the same name is already registered.
 */
export function test(name: string, fn: TestFn<Record<string, any>>): void {
  const tests = registry();
  if (tests.some((registered) => registered.name === name)) {
    throw new Error(`duplicate test name "${name}"`);
  }
  tests.push({ name, fn });
}

/**
 * The same {@link test}, typed by the contract fields, for the editor only:
 * `const test = tests<{ result: (a: number, b: number) => number }>();`.
 */
export function tests<F extends { result: unknown }>(): (name: string, fn: TestFn<F>) => void {
  return test as (name: string, fn: TestFn<F>) => void;
}

/** Internal, not part of the documented API: the registered tests, in order. */
export function registeredTests(): Registered[] {
  return [...registry()];
}

/** Internal, not part of the documented API: forgets every registered test. Tests only. */
export function resetTests(): void {
  registry().length = 0;
}
