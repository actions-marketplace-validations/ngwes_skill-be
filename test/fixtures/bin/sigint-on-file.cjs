// Preloaded with `node --require` into the CLI: once the file $SKILL_BE_SIGINT_WHEN exists, the
// process gets a SIGINT event, as on Ctrl+C. Windows cannot send a real SIGINT to a child.
const { existsSync } = require('node:fs');

const file = process.env.SKILL_BE_SIGINT_WHEN;
if (file) {
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    clearInterval(timer);
    process.emit('SIGINT', 'SIGINT');
  }, 50);
  timer.unref();
}
