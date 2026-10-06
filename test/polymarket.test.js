const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh } = require('./helpers');

let clobCalls;
let postOrderResult;
let fetchResult;
let fetchedUrls;
let loggedOrders;

const fakeClob = {
  Side: { BUY: 'BUY', SELL: 'SELL' },
  OrderType: { GTC: 'GTC', GTD: 'GTD' },
  ClobClient: class {
    async createOrder(args) {
      clobCalls.push({ type: 'createOrder', ...args });
      return { signed: args };
    }
    async postOrder(order, orderType) {
      clobCalls.push({ type: 'postOrder', orderType });
      if (postOrderResult instanceof Error) throw postOrderResult;
      return postOrderResult;
    }
    async cancelOrder(payload) {
      clobCalls.push({ type: 'cancelOrder', ...payload });
    }
  },
};

const fakeFetch = async (url) => {
  fetchedUrls.push(url);
  if (fetchResult instanceof Error) throw fetchResult;
  return fetchResult;
};

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

function loadPolymarket(env) {
  return loadFresh('src/polymarket.js', {
    env,
    stubs: {
      '@polymarket/clob-client': fakeClob,
      '@polymarket/order-utils': { SignatureType: { POLY_GNOSIS_SAFE: 2 } },
      'node-fetch': fakeFetch,
      './src/db.js': { logOrder: async (entry) => loggedOrders.push(entry) },
    },
  });
}

beforeEach(() => {
  clobCalls = [];
  postOrderResult = { success: true, orderID: '0xabc' };
  fetchResult = okJson([]);
  fetchedUrls = [];
  loggedOrders = [];
});

describe('placing orders', () => {
  it('in dry-run mode, logs the order but never signs or sends it', async () => {
    const pm = loadPolymarket({ DRY_RUN: 'true' });
    const result = await pm.buy('TOKEN', 0.5, 100);

    assert.equal(result.success, true);
    assert.equal(clobCalls.length, 0);
    assert.equal(loggedOrders.length, 1);
    assert.equal(loggedOrders[0].side, 'BUY');
  });

  it('in dry-run mode, never cancels real orders', async () => {
    const pm = loadPolymarket({ DRY_RUN: 'true' });
    await pm.cancelOrder('0xabc');
    assert.equal(clobCalls.length, 0);
  });

  it('places buys as good-till-cancelled orders and returns the response', async () => {
    const pm = loadPolymarket();
    const result = await pm.buy('TOKEN', '0.5', 100);

    assert.deepEqual(result, { success: true, orderID: '0xabc' });
    const created = clobCalls.find((c) => c.type === 'createOrder');
    assert.equal(created.price, 0.5); // string prices from the order book become numbers
    assert.equal(created.expiration, undefined);
    assert.equal(clobCalls.find((c) => c.type === 'postOrder').orderType, 'GTC');
  });

  it('places sells as good-till-date orders that expire after SELL_ORDER_TTL_SECONDS', async () => {
    const pm = loadPolymarket({ SELL_ORDER_TTL_SECONDS: '65' });
    const before = Math.floor(Date.now() / 1000);
    await pm.sell('TOKEN', 0.2, 100);

    const created = clobCalls.find((c) => c.type === 'createOrder');
    assert.equal(created.side, 'SELL');
    assert.ok(created.expiration >= before + 65 && created.expiration <= before + 66);
    assert.equal(clobCalls.find((c) => c.type === 'postOrder').orderType, 'GTD');
  });

  it('returns null when Polymarket rejects the order', async () => {
    postOrderResult = { success: false, errorMsg: 'not enough balance' };
    const pm = loadPolymarket();

    assert.equal(await pm.buy('TOKEN', 0.5, 100), null);
    assert.equal(loggedOrders[0].success, false);
  });

  it('returns null instead of throwing when the API call fails', async () => {
    postOrderResult = new Error('network down');
    const pm = loadPolymarket();

    assert.equal(await pm.buy('TOKEN', 0.5, 100), null);
    assert.equal(loggedOrders[0].error, 'network down');
  });

  it('cancels orders by ID in live mode', async () => {
    const pm = loadPolymarket();
    await pm.cancelOrder('0xabc');
    assert.deepEqual(clobCalls, [{ type: 'cancelOrder', orderID: '0xabc' }]);
  });
});

describe('reading positions', () => {
  it('requests positions for the configured proxy wallet', async () => {
    fetchResult = okJson([{ asset: 'A' }]);
    const pm = loadPolymarket({ PROXY_ADDRESS: '0xMyWallet' });

    assert.deepEqual(await pm.fetchPositions(), [{ asset: 'A' }]);
    assert.match(fetchedUrls[0], /\/positions\?user=0xMyWallet$/);
  });

  const failures = [
    ['the API returns an HTTP error', () => ({ ok: false, status: 503 })],
    ['the request throws', () => new Error('timeout')],
    ['the response is not a list', () => okJson({ error: 'rate limited' })],
  ];

  for (const [reason, makeResult] of failures) {
    it(`returns null, not an empty list, when ${reason}`, async () => {
      fetchResult = makeResult();
      const pm = loadPolymarket();
      assert.equal(await pm.fetchPositions(), null);
    });
  }
});

describe('finding live games', () => {
  it('keeps only live NBA events', async () => {
    fetchResult = okJson([
      { id: 1, seriesSlug: 'nba', live: true },
      { id: 2, seriesSlug: 'nba', live: false },
      { id: 3, seriesSlug: 'nfl', live: true },
    ]);
    const pm = loadPolymarket();

    assert.deepEqual((await pm.fetchLiveNbaEvents()).map((e) => e.id), [1]);
  });

  it('throws when the Gamma API returns an error', async () => {
    fetchResult = { ok: false, status: 500 };
    const pm = loadPolymarket();
    await assert.rejects(pm.fetchLiveNbaEvents(), /HTTP 500/);
  });
});

describe('order book helpers', () => {
  it('reads the best price from the end of the list', () => {
    const pm = loadPolymarket();
    const levels = [{ price: '0.55' }, { price: '0.52' }, { price: '0.50' }];

    assert.equal(pm.bestPrice(levels), '0.50');
    assert.equal(pm.bestPrice(levels, 2), '0.52');
    assert.equal(pm.bestPrice([]), undefined);
    assert.equal(pm.bestPrice(undefined), undefined);
  });
});
