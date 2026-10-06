// Shared test utilities: swap real modules for fakes so tests never touch
// the network, a wallet, a database, or a developer's real .env file.
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const BASE_ENV = {
  CLOB_API_KEY: 'test-key',
  CLOB_SECRET: 'test-secret',
  CLOB_PASS_PHRASE: 'test-passphrase',
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  PROXY_ADDRESS: '0x000000000000000000000000000000000000dEaD',
  DRY_RUN: 'false',
  // Trade at any hour so tests don't depend on the clock
  TRADING_START_HOUR: '0',
  TRADING_END_HOUR: '24',
};

const CONFIG_KEYS = [
  ...Object.keys(BASE_ENV),
  'MONGODB_URI', 'MONGODB_DB', 'PORT', 'INTERVAL_MS', 'TRADING_TIMEZONE',
  'CLOB_API_URL', 'GAMMA_API_URL', 'DATA_API_URL',
  'USD_PER_SIDE', 'MAX_ENTRY_SPREAD', 'MIN_ENTRY_PRICE', 'MAX_ENTRY_PRICE',
  'MAX_COMBINED_ASK', 'STOP_LOSS_PRICE', 'TAKE_PROFIT_PRICE', 'MAX_EXIT_SPREAD',
  'SELL_ORDER_TTL_SECONDS', 'GAME_DURATION_MINUTES',
];

function setEnv(overrides = {}) {
  for (const key of CONFIG_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
}

// Put a fake module in the require cache, under the path the real one resolves to
function stub(request, exports) {
  const filename = request.startsWith('.') || path.isAbsolute(request)
    ? require.resolve(path.resolve(ROOT, request))
    : require.resolve(request, { paths: [ROOT] });
  const mod = new Module(filename);
  mod.filename = filename;
  mod.exports = exports;
  mod.loaded = true;
  require.cache[filename] = mod;
}

// Re-require a source module with fresh state (and fresh config from process.env)
function loadFresh(relativePath, { env, stubs = {} } = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }
  setEnv(env);
  stub('dotenv', { config() {} }); // never read the developer's real .env
  for (const [request, exports] of Object.entries(stubs)) stub(request, exports);
  return require(path.join(ROOT, relativePath));
}

// --- Market data builders ---------------------------------------------------

// Order books list the best ask and best bid as the last item
function book({ asks = [], bids = [] } = {}) {
  return {
    asks: asks.map((price) => ({ price: String(price), size: '100' })),
    bids: bids.map((price) => ({ price: String(price), size: '100' })),
  };
}

function liveGame({
  tokens = ['TOKEN_A', 'TOKEN_B'],
  teams = ['Lakers', 'Celtics'],
  spread = 0.01,
  startedMinutesAgo = 30,
} = {}) {
  return {
    seriesSlug: 'nba',
    live: true,
    markets: [{
      clobTokenIds: JSON.stringify(tokens),
      outcomes: JSON.stringify(teams),
      spread,
      gameStartTime: new Date(Date.now() - startedMinutesAgo * 60 * 1000).toISOString(),
    }],
  };
}

function position(overrides = {}) {
  return {
    asset: 'HELD',
    slug: 'nba-lal-bos',
    outcome: 'Lakers',
    currentValue: 10,
    redeemable: false,
    size: 100,
    ...overrides,
  };
}

// --- Fake Polymarket module for strategy tests ------------------------------

function createFakePolymarket({
  events = [],
  positions = [],
  books = {},
  spreads = {},
  openOrders = {},
  failBuyNumbers = [],
} = {}) {
  const calls = [];
  let buyCount = 0;

  return {
    calls,
    orders: (type) => calls.filter((call) => call.type === type),
    bestPrice: (levels, offset = 1) => levels?.[levels.length - offset]?.price,
    async fetchPositions() {
      calls.push({ type: 'fetchPositions' });
      return positions;
    },
    async fetchLiveNbaEvents() {
      calls.push({ type: 'fetchLiveNbaEvents' });
      return events;
    },
    async getOrderBook(tokenID) {
      if (books[tokenID] instanceof Error) throw books[tokenID];
      return books[tokenID] ?? book();
    },
    async getSpread(tokenID) {
      return spreads[tokenID] ?? 0.02;
    },
    async hasOpenOrders(tokenID) {
      return Boolean(openOrders[tokenID]);
    },
    async buy(tokenID, price, size) {
      buyCount += 1;
      calls.push({ type: 'buy', tokenID, price, size });
      return failBuyNumbers.includes(buyCount) ? null : { success: true, orderID: `order-${buyCount}` };
    },
    async sell(tokenID, price, size) {
      calls.push({ type: 'sell', tokenID, price, size });
      openOrders[tokenID] = true; // the sell now rests on the book
      return { success: true, orderID: `sell-${tokenID}` };
    },
    async cancelOrder(orderID) {
      calls.push({ type: 'cancel', orderID });
    },
  };
}

module.exports = {
  ROOT,
  setEnv,
  stub,
  loadFresh,
  book,
  liveGame,
  position,
  createFakePolymarket,
};
