require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return value;
}

const config = {
  // Safety: orders are only logged unless DRY_RUN is explicitly "false"
  dryRun: process.env.DRY_RUN !== 'false',

  polymarket: {
    clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    gammaApiUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    dataApiUrl: process.env.DATA_API_URL || 'https://data-api.polymarket.com',
    chainId: 137, // Polygon
    apiKey: required('CLOB_API_KEY'),
    secret: required('CLOB_SECRET'),
    passphrase: required('CLOB_PASS_PHRASE'),
    privateKey: required('PRIVATE_KEY'),
    proxyAddress: required('PROXY_ADDRESS'),
  },

  // Optional: when set, every order is logged to MongoDB
  mongodbUri: process.env.MONGODB_URI || '',
  mongodbDb: process.env.MONGODB_DB || 'polymarket',

  port: number('PORT', 3312),

  schedule: {
    intervalMs: number('INTERVAL_MS', 5000),
    timezone: process.env.TRADING_TIMEZONE || 'America/Los_Angeles',
    startHour: number('TRADING_START_HOUR', 10), // inclusive
    endHour: number('TRADING_END_HOUR', 22), // exclusive
  },

  strategy: {
    usdPerSide: number('USD_PER_SIDE', 50),
    maxEntrySpread: number('MAX_ENTRY_SPREAD', 0.05),
    minEntryPrice: number('MIN_ENTRY_PRICE', 0.30),
    maxEntryPrice: number('MAX_ENTRY_PRICE', 0.70),
    maxCombinedAsk: number('MAX_COMBINED_ASK', 1.02),
    stopLossPrice: number('STOP_LOSS_PRICE', 0.25),
    takeProfitPrice: number('TAKE_PROFIT_PRICE', 0.96),
    maxExitSpread: number('MAX_EXIT_SPREAD', 0.06),
    sellOrderTtlSeconds: number('SELL_ORDER_TTL_SECONDS', 65),
    // 4 x 12 min quarters + 15 min halftime + 48 min of stoppages and breaks
    gameDurationMinutes: number('GAME_DURATION_MINUTES', 111),
  },
};

module.exports = config;
