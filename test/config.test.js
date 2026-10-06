const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh } = require('./helpers');

const loadConfig = (env) => loadFresh('src/config.js', { env });

describe('config', () => {
  it('is in dry-run mode unless DRY_RUN is exactly "false"', () => {
    assert.equal(loadConfig({ DRY_RUN: undefined }).dryRun, true);
    assert.equal(loadConfig({ DRY_RUN: 'true' }).dryRun, true);
    assert.equal(loadConfig({ DRY_RUN: 'no' }).dryRun, true);
    assert.equal(loadConfig({ DRY_RUN: 'false' }).dryRun, false);
  });

  for (const name of ['CLOB_API_KEY', 'CLOB_SECRET', 'CLOB_PASS_PHRASE', 'PRIVATE_KEY', 'PROXY_ADDRESS']) {
    it(`refuses to start without ${name}`, () => {
      assert.throws(() => loadConfig({ [name]: undefined }), new RegExp(name));
    });
  }

  it('rejects a setting that is not a number', () => {
    assert.throws(() => loadConfig({ USD_PER_SIDE: '5O' }), /USD_PER_SIDE must be a number/);
  });

  it('uses safe defaults for optional settings', () => {
    const config = loadConfig({ TRADING_START_HOUR: undefined, TRADING_END_HOUR: undefined });

    assert.equal(config.mongodbUri, '');
    assert.equal(config.polymarket.clobApiUrl, 'https://clob.polymarket.com');
    assert.deepEqual(config.schedule, {
      intervalMs: 5000, timezone: 'America/Los_Angeles', startHour: 10, endHour: 22,
    });
    assert.equal(config.strategy.usdPerSide, 50);
    assert.equal(config.strategy.stopLossPrice, 0.25);
    assert.equal(config.strategy.takeProfitPrice, 0.96);
  });

  it('lets every strategy setting be overridden from the environment', () => {
    const config = loadConfig({ USD_PER_SIDE: '10', STOP_LOSS_PRICE: '0.2', TAKE_PROFIT_PRICE: '0.9' });

    assert.equal(config.strategy.usdPerSide, 10);
    assert.equal(config.strategy.stopLossPrice, 0.2);
    assert.equal(config.strategy.takeProfitPrice, 0.9);
  });
});
