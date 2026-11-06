import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registeredTests, resetTests, test, tests } from '../src/testing.js';

beforeEach(() => {
  resetTests();
});

describe('test', () => {
  it('registers tests in order', () => {
    const first = () => {};
    const second = async () => {};
    test('first', first);
    test('second', second);
    expect(registeredTests()).toEqual([
      { name: 'first', fn: first },
      { name: 'second', fn: second },
    ]);
  });

  it('rejects a duplicate test name', () => {
    test('same', () => {});
    expect(() => test('same', () => {})).toThrow('duplicate test name "same"');
    expect(registeredTests().map((registered) => registered.name)).toEqual(['same']);
  });

  it('hands the test the fields it is called with', () => {
    let seen: unknown;
    test('reads', (fields) => {
      seen = fields.result;
    });
    registeredTests()[0]!.fn({ result: 42 });
    expect(seen).toBe(42);
  });
});

describe('tests<F>()', () => {
  it('registers into the same list', () => {
    const typed = tests<{ result: number }>();
    typed('typed', ({ result }) => {
      expect(result).toBe(1);
    });
    test('plain', () => {});
    expect(registeredTests().map((registered) => registered.name)).toEqual(['typed', 'plain']);
  });

  it('rejects a name the plain test already registered', () => {
    test('same', () => {});
    expect(() => tests<{ result: number }>()('same', () => {})).toThrow(
      'duplicate test name "same"',
    );
  });
});

describe('the registry', () => {
  it('is shared by two instances of the module', async () => {
    test('from the first instance', () => {});
    vi.resetModules();
    const other = await import('../src/testing.js');
    expect(other.registeredTests).not.toBe(registeredTests);
    other.test('from the second instance', () => {});
    expect(registeredTests().map((registered) => registered.name)).toEqual([
      'from the first instance',
      'from the second instance',
    ]);
    expect(other.registeredTests().map((registered) => registered.name)).toEqual([
      'from the first instance',
      'from the second instance',
    ]);
  });

  it('lives on globalThis under Symbol.for("skill-be.tests")', () => {
    test('listed', () => {});
    const shared = (globalThis as Record<symbol, unknown>)[Symbol.for('skill-be.tests')];
    expect(shared).toEqual([{ name: 'listed', fn: expect.any(Function) }]);
  });

  it('is emptied by resetTests', () => {
    test('gone', () => {});
    resetTests();
    expect(registeredTests()).toEqual([]);
    expect(() => test('gone', () => {})).not.toThrow();
  });

  it('returns a copy, so a caller cannot change the list', () => {
    test('kept', () => {});
    registeredTests().pop();
    expect(registeredTests()).toHaveLength(1);
  });
});
