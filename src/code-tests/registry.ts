/**
 * The list of registered code tests, behind the wrapper `@ngwes/skill-be/testing`: its `test`
 * adds to it, and the child reads it. Internal: the package exports none of it.
 *
 * The list is on `globalThis`, not in the module: skill-be's runner and the compiled test file
 * may each load their own copy of this module, and both must see one list.
 */

/** A registered test; its function gets the fields the answer exports. */
export type RegisteredTest = {
  name: string;
  fn: (fields: Record<string, unknown>) => void | Promise<void>;
};

const REGISTRY = Symbol.for('skill-be.tests');

function registry(): RegisteredTest[] {
  const holder = globalThis as { [REGISTRY]?: RegisteredTest[] };
  return (holder[REGISTRY] ??= []);
}

/**
 * Adds a test at the end of the list.
 *
 * @throws Error when a test with the same name is already registered.
 */
export function registerTest(name: string, fn: RegisteredTest['fn']): void {
  const tests = registry();
  if (tests.some((registered) => registered.name === name)) {
    throw new Error(`duplicate test name "${name}"`);
  }
  tests.push({ name, fn });
}

/** The registered tests, in order: a copy, so a caller cannot change the list. */
export function registeredTests(): RegisteredTest[] {
  return [...registry()];
}

/** Forgets every registered test. Tests only. */
export function resetTests(): void {
  registry().length = 0;
}
