import assert from 'node:assert/strict';
import { tests } from '@ngwes/skill-be/testing';
import { fakeDeps, type Signup } from './fakes.js';

const test = tests<{ result: Signup }>();

const input = { email: 'ada@example.com', password: 'correct horse battery' };

test('responds 201 with the new user when the input is valid', async ({ result }) => {
  const deps = fakeDeps({ taken: false });

  const response = await result(deps)(input);

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { id: 1, email: 'ada@example.com' });
});

test('responds 409 and saves nobody when the email is taken', async ({ result }) => {
  const deps = fakeDeps({ taken: true });

  const response = await result(deps)(input);

  assert.equal(response.status, 409);
  assert.equal(deps.created.length, 0);
});

test('responds 422 and saves nobody when the password is too short', async ({ result }) => {
  const deps = fakeDeps({ taken: false });

  const response = await result(deps)({ ...input, password: 'short' });

  assert.equal(response.status, 422);
  assert.equal(deps.created.length, 0);
});
