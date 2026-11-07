import { tests } from '@ngwes/skill-be/testing';
import { expectedSum } from 'local-lib';
import { pairs } from './helpers.js';

const test = tests<{ result: (a: number, b: number) => number }>();

test('adds two numbers', ({ result }) => {
  for (const [a, b] of pairs) {
    const got = result(a, b);
    if (got !== expectedSum(a, b)) {
      throw new Error(`result(${a}, ${b}) returned ${got}, expected ${expectedSum(a, b)}`);
    }
  }
});
