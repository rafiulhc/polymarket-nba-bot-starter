async function main() {
  // Required inside main so a missing .env value prints a clear message, not a stack trace
  const express = require('express');
  const config = require('./src/config');
  const { connectToDB } = require('./src/db');
  const { tick } = require('./src/bot');

  console.log(config.dryRun
    ? 'DRY RUN mode: orders are logged, not placed. Set DRY_RUN=false to trade.'
    : 'LIVE mode: real orders will be placed.');

  await connectToDB();

  setInterval(tick, config.schedule.intervalMs);

  // Minimal HTTP server: lets hosts like Heroku see the app is up
  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true, dryRun: config.dryRun }));
  app.listen(config.port, () => console.log(`Health check on port ${config.port}`));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
