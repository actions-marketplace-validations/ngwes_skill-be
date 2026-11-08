// The model of the code-tests fixture, for the command adapter: it reads the prompt on stdin and
// answers one TypeScript code block. With the skill (the prompt holds the skill's marker sentence)
// the block adds; without it, it multiplies, so the baseline fails the test. Every call appends a
// line to fake-model.called in the working directory, so a test can tell that a model ran. With
// SKILL_BE_FIXTURE_HANG=1 it never answers.
import { appendFileSync } from 'node:fs';

const MARKER = 'Sum skill marker: a sum adds its two arguments, it never multiplies them.';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  appendFileSync('fake-model.called', 'called\n');
  if (process.env.SKILL_BE_FIXTURE_HANG === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  const operator = prompt.includes(MARKER) ? '+' : '*';
  const code = `export const result = (a: number, b: number): number => a ${operator} b;`;
  process.stdout.write(`Here is the module:\n\n\`\`\`ts\n${code}\n\`\`\`\n`);
});
