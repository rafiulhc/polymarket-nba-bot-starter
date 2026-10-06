const moment = require('moment-timezone');
const config = require('./config');
const pm = require('./polymarket');

const { strategy, schedule } = config;

// Shares bought per token in this process, so the same game isn't bought twice
// before the positions API catches up (and in dry-run mode, where it never does)
const boughtTokens = new Map();

function isWithinTradingHours() {
  const hour = moment().tz(schedule.timezone).hour();
  return hour >= schedule.startHour && hour < schedule.endHour;
}

function gameTimeRemainingMs(gameStartTime) {
  const end = new Date(gameStartTime).getTime() + strategy.gameDurationMinutes * 60 * 1000;
  return end - Date.now();
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function holdsGame(positions, tokenIds) {
  return positions.some((p) => tokenIds.includes(p.asset) || tokenIds.includes(p.oppositeAsset));
}

async function hasOpenOrdersOrShares(tokenIds) {
  for (const tokenID of tokenIds) {
    if (boughtTokens.get(tokenID) > 0) return true;
    if (await pm.hasOpenOrders(tokenID)) return true;
  }
  return false;
}

function isEntryPrice(price) {
  return price >= strategy.minEntryPrice && price <= strategy.maxEntryPrice;
}

// Buy both teams in one game if the entry rules are met
async function tryEnterGame(subMarket, positions) {
  const tokenIds = JSON.parse(subMarket.clobTokenIds);
  const teams = JSON.parse(subMarket.outcomes);
  const label = `${teams[0]} vs ${teams[1]}`;

  const remaining = gameTimeRemainingMs(subMarket.gameStartTime);
  if (remaining <= 0) {
    console.log(`${label}: game has ended.`);
    return;
  }
  console.log(`${label}: ~${formatDuration(remaining)} left, spread ${subMarket.spread}`);

  if (holdsGame(positions, tokenIds) || (await hasOpenOrdersOrShares(tokenIds))) {
    console.log(`${label}: already in this game, skipping.`);
    return;
  }
  if (Number(subMarket.spread) > strategy.maxEntrySpread) {
    console.log(`${label}: spread too wide, skipping.`);
    return;
  }

  const books = await Promise.all(tokenIds.map((id) => pm.getOrderBook(id)));
  const bestAsks = books.map((book) => Number(pm.bestPrice(book.asks)));
  console.log(`${label}: best asks ${bestAsks[0]} / ${bestAsks[1]}`);

  if (!bestAsks.every(isEntryPrice) || bestAsks[0] + bestAsks[1] > strategy.maxCombinedAsk) {
    console.log(`${label}: prices outside entry rules, skipping.`);
    return;
  }

  // Bid at the second-best ask so the order fills, falling back to the best ask
  const orders = books.map((book, i) => {
    const price = Number(pm.bestPrice(book.asks, 2) ?? pm.bestPrice(book.asks));
    // Round down, never up, so the order costs at most usdPerSide
    const size = Math.floor((strategy.usdPerSide / price) * 100) / 100;
    return { tokenID: tokenIds[i], team: teams[i], price, size };
  });

  console.log(`${label}: entry rules met, buying both teams.`);
  const first = await pm.buy(orders[0].tokenID, orders[0].price, orders[0].size);
  if (!first) {
    console.error(`${label}: failed to buy ${orders[0].team}, not buying ${orders[1].team}.`);
    return;
  }

  const second = await pm.buy(orders[1].tokenID, orders[1].price, orders[1].size);
  if (!second) {
    // Avoid holding only one side. Any part that already filled is handled by the exit rules.
    console.error(`${label}: failed to buy ${orders[1].team}, cancelling ${orders[0].team} order.`);
    await pm.cancelOrder(first.orderID);
    return;
  }

  orders.forEach((order) => boughtTokens.set(order.tokenID, order.size));
  console.log(`${label}: bought both teams.`);
}

// Sell each NBA position when it hits the stop-loss or take-profit price
async function manageExits(positions) {
  const open = positions.filter(
    (p) => p.slug?.includes('nba') && p.redeemable === false && p.currentValue > 0
  );

  for (const position of open) {
    // An error on one position must not stop the others from being sold
    try {
      // A sell from an earlier cycle may still be open; don't stack another one
      if (await pm.hasOpenOrders(position.asset)) {
        console.log(`${position.outcome}: sell order already open, skipping.`);
        continue;
      }

      const book = await pm.getOrderBook(position.asset);
      const bestBid = Number(pm.bestPrice(book.bids));
      if (!bestBid) {
        console.log(`${position.outcome}: no bids, skipping.`);
        continue;
      }

      const spread = await pm.getSpread(position.asset);
      const hitExit = bestBid <= strategy.stopLossPrice || bestBid >= strategy.takeProfitPrice;
      console.log(`${position.outcome}: best bid ${bestBid}, spread ${spread}`);

      if (hitExit && spread <= strategy.maxExitSpread) {
        const sold = await pm.sell(position.asset, bestBid, Number(position.size.toFixed(6)));
        if (sold) boughtTokens.delete(position.asset);
      }
    } catch (error) {
      console.error(`${position.outcome}: error while selling:`, error.message);
    }
  }
}

async function runCycle() {
  // Without positions we can't tell what we already own, so do nothing this cycle
  const positions = await pm.fetchPositions();
  if (!positions) {
    console.log('Could not load positions, skipping this cycle.');
    return;
  }

  try {
    const events = await pm.fetchLiveNbaEvents();
    console.log(`Live NBA events: ${events.length}`);
    for (const event of events) {
      for (const subMarket of event.markets || []) {
        try {
          await tryEnterGame(subMarket, positions);
        } catch (error) {
          console.error('Error while checking game:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error fetching live NBA events:', error.message);
  }

  await manageExits(positions);
}

let isRunning = false;

// Skips a tick if the previous cycle is still running, so orders are never doubled
async function tick() {
  if (isRunning) {
    console.log('Previous cycle still running, skipping.');
    return;
  }
  isRunning = true;
  try {
    if (isWithinTradingHours()) {
      await runCycle();
    } else {
      console.log('Outside trading hours, skipping.');
    }
  } finally {
    isRunning = false;
  }
}

module.exports = { tick };
