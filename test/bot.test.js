const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh, book, liveGame, position, createFakePolymarket } = require('./helpers');

// A close game that passes every entry rule
const GOOD_BOOKS = {
  TOKEN_A: book({ asks: [0.52, 0.50], bids: [0.48] }),
  TOKEN_B: book({ asks: [0.53, 0.51], bids: [0.49] }),
};

function loadBot(fake, env) {
  return loadFresh('src/bot.js', { env, stubs: { './src/polymarket.js': fake } });
}

describe('entry rules', () => {
  it('buys both teams at the second-best ask when every rule is met', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS });
    await loadBot(pm).tick();

    assert.deepEqual(pm.orders('buy'), [
      { type: 'buy', tokenID: 'TOKEN_A', price: 0.52, size: 96.15 },
      { type: 'buy', tokenID: 'TOKEN_B', price: 0.53, size: 94.33 }, // 94.339… rounded down
    ]);
  });

  it('never spends more than USD_PER_SIDE on one team', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS });
    await loadBot(pm, { USD_PER_SIDE: '20' }).tick();

    for (const order of pm.orders('buy')) {
      assert.ok(order.price * order.size <= 20, `spent ${order.price * order.size}`);
    }
  });

  it('falls back to the best ask when there is only one ask level', async () => {
    const books = {
      TOKEN_A: book({ asks: [0.50] }),
      TOKEN_B: book({ asks: [0.50] }),
    };
    const pm = createFakePolymarket({ events: [liveGame()], books });
    await loadBot(pm).tick();

    assert.deepEqual(pm.orders('buy').map((o) => o.price), [0.50, 0.50]);
  });

  const skipCases = [
    ['the market spread is too wide', { events: [liveGame({ spread: 0.08 })], books: GOOD_BOOKS }],
    ['a team is priced above the entry range', {
      events: [liveGame()],
      books: { TOKEN_A: book({ asks: [0.80, 0.75] }), TOKEN_B: book({ asks: [0.30, 0.28] }) },
    }],
    ['a team is priced below the entry range', {
      events: [liveGame()],
      books: { TOKEN_A: book({ asks: [0.30, 0.25] }), TOKEN_B: book({ asks: [0.80, 0.74] }) },
    }],
    ['both asks together cost more than MAX_COMBINED_ASK', {
      events: [liveGame()],
      books: { TOKEN_A: book({ asks: [0.56, 0.55] }), TOKEN_B: book({ asks: [0.51, 0.50] }) },
    }],
    ['the game has already ended', { events: [liveGame({ startedMinutesAgo: 200 })], books: GOOD_BOOKS }],
    ['a position in the game is already held', {
      events: [liveGame()], books: GOOD_BOOKS, positions: [position({ asset: 'TOKEN_B', currentValue: 0 })],
    }],
    ['an order is already open in the game', {
      events: [liveGame()], books: GOOD_BOOKS, openOrders: { TOKEN_A: true },
    }],
  ];

  for (const [reason, scenario] of skipCases) {
    it(`does not buy when ${reason}`, async () => {
      const pm = createFakePolymarket(scenario);
      await loadBot(pm).tick();
      assert.equal(pm.orders('buy').length, 0);
    });
  }
});

describe('order safety', () => {
  it('does not buy the second team if the first buy fails', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS, failBuyNumbers: [1] });
    await loadBot(pm).tick();

    assert.equal(pm.orders('buy').length, 1);
    assert.equal(pm.orders('cancel').length, 0);
  });

  it('cancels the first order if the second buy fails', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS, failBuyNumbers: [2] });
    await loadBot(pm).tick();

    assert.deepEqual(pm.orders('cancel'), [{ type: 'cancel', orderID: 'order-1' }]);
  });

  it('does not buy the same game again on later cycles', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS });
    const bot = loadBot(pm);
    await bot.tick();
    await bot.tick();
    await bot.tick();

    assert.equal(pm.orders('buy').length, 2);
  });

  it('skips a cycle that starts while the previous one is still running', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS });
    const bot = loadBot(pm);
    await Promise.all([bot.tick(), bot.tick(), bot.tick()]);

    assert.equal(pm.orders('fetchPositions').length, 1);
    assert.equal(pm.orders('buy').length, 2);
  });

  it('does nothing at all when positions cannot be loaded (fails closed)', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS, positions: null });
    await loadBot(pm).tick();

    assert.equal(pm.orders('fetchLiveNbaEvents').length, 0);
    assert.equal(pm.orders('buy').length, 0);
  });

  it('does nothing outside trading hours', async () => {
    const pm = createFakePolymarket({ events: [liveGame()], books: GOOD_BOOKS });
    await loadBot(pm, { TRADING_START_HOUR: '0', TRADING_END_HOUR: '0' }).tick();

    assert.equal(pm.calls.length, 0);
  });

  it('keeps checking other games when one game throws an error', async () => {
    const broken = liveGame({ tokens: ['BROKEN_A', 'BROKEN_B'] });
    const books = { ...GOOD_BOOKS, BROKEN_A: new Error('order book unavailable') };
    const pm = createFakePolymarket({ events: [broken, liveGame()], books });
    await loadBot(pm).tick();

    assert.deepEqual(pm.orders('buy').map((o) => o.tokenID), ['TOKEN_A', 'TOKEN_B']);
  });
});

describe('exit rules', () => {
  async function runExit({ bid, spread = 0.02, ...scenario }) {
    const pm = createFakePolymarket({
      positions: [position()],
      books: { HELD: book({ bids: [bid] }) },
      spreads: { HELD: spread },
      ...scenario,
    });
    await loadBot(pm).tick();
    return pm;
  }

  it('sells the whole position at the best bid when the stop-loss is hit', async () => {
    const pm = await runExit({ bid: 0.20 });
    assert.deepEqual(pm.orders('sell'), [{ type: 'sell', tokenID: 'HELD', price: 0.20, size: 100 }]);
  });

  it('sells when the take-profit is hit', async () => {
    const pm = await runExit({ bid: 0.97 });
    assert.equal(pm.orders('sell').length, 1);
  });

  it('holds when the price is between stop-loss and take-profit', async () => {
    const pm = await runExit({ bid: 0.60 });
    assert.equal(pm.orders('sell').length, 0);
  });

  it('holds when the spread is too wide to sell', async () => {
    const pm = await runExit({ bid: 0.20, spread: 0.10 });
    assert.equal(pm.orders('sell').length, 0);
  });

  it('does not stack a new sell while an earlier one is still open', async () => {
    const pm = createFakePolymarket({ positions: [position()], books: { HELD: book({ bids: [0.20] }) } });
    const bot = loadBot(pm);
    await bot.tick();
    await bot.tick();

    assert.equal(pm.orders('sell').length, 1);
  });

  it('ignores positions that are not NBA, already redeemable, or empty', async () => {
    const pm = createFakePolymarket({
      positions: [
        position({ asset: 'NFL', slug: 'nfl-kc-buf' }),
        position({ asset: 'DONE', redeemable: true }),
        position({ asset: 'EMPTY', currentValue: 0 }),
      ],
      books: { NFL: book({ bids: [0.1] }), DONE: book({ bids: [0.1] }), EMPTY: book({ bids: [0.1] }) },
    });
    await loadBot(pm).tick();

    assert.equal(pm.orders('sell').length, 0);
  });

  it('keeps selling other positions when one throws an error or has no bids', async () => {
    const pm = createFakePolymarket({
      positions: [position({ asset: 'BROKEN' }), position({ asset: 'NO_BIDS' }), position()],
      books: { BROKEN: new Error('order book unavailable'), NO_BIDS: book(), HELD: book({ bids: [0.20] }) },
    });
    await loadBot(pm).tick();

    assert.deepEqual(pm.orders('sell').map((o) => o.tokenID), ['HELD']);
  });
});
