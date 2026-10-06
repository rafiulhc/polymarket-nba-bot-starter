const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const { SignatureType } = require('@polymarket/order-utils');
const { ethers } = require('ethers');
const fetch = require('node-fetch');
const config = require('./config');
const { logOrder } = require('./db');

const pm = config.polymarket;

const clobClient = new ClobClient(
  pm.clobApiUrl,
  pm.chainId,
  new ethers.Wallet(pm.privateKey),
  { key: pm.apiKey, secret: pm.secret, passphrase: pm.passphrase },
  SignatureType.POLY_GNOSIS_SAFE,
  pm.proxyAddress
);

// Order books list the best ask and best bid as the last item
function bestPrice(levels, offset = 1) {
  return levels?.[levels.length - offset]?.price;
}

async function getOrderBook(tokenID) {
  return clobClient.getOrderBook(tokenID);
}

async function getSpread(tokenID) {
  const result = await clobClient.getSpread(tokenID);
  return Number(result.spread);
}

async function hasOpenOrders(tokenID) {
  const openOrders = await clobClient.getOpenOrders({ asset_id: tokenID });
  return openOrders.length > 0;
}

// Returns the order response (with orderID) on success, or null on failure
async function submitOrder({ tokenID, price, side, size, orderType, expiration }) {
  const details = { tokenID, price: Number(price), side, size, orderType };

  if (config.dryRun) {
    console.log('[DRY RUN] would place order', details);
    await logOrder({ ...details, success: true });
    return { success: true, orderID: `dry-run-${Date.now()}` };
  }

  try {
    const order = await clobClient.createOrder({
      tokenID,
      price: Number(price),
      side,
      size,
      feeRateBps: 0,
      ...(expiration ? { expiration } : {}),
    });
    const response = await clobClient.postOrder(order, orderType);
    console.log('order response', response);
    await logOrder({ ...details, success: response.success === true, response });
    return response.success === true ? response : null;
  } catch (error) {
    console.error(`Error placing ${side} order for token ${tokenID}:`, error.message);
    await logOrder({ ...details, success: false, error: error.message });
    return null;
  }
}

function buy(tokenID, price, size) {
  return submitOrder({ tokenID, price, side: Side.BUY, size, orderType: OrderType.GTC });
}

// Sells expire quickly so a stale price never sits on the order book
function sell(tokenID, price, size) {
  const expiration = Math.floor(Date.now() / 1000) + config.strategy.sellOrderTtlSeconds;
  return submitOrder({ tokenID, price, side: Side.SELL, size, orderType: OrderType.GTD, expiration });
}

async function cancelOrder(orderID) {
  if (config.dryRun) {
    console.log(`[DRY RUN] would cancel order ${orderID}`);
    return;
  }
  try {
    await clobClient.cancelOrder({ orderID });
  } catch (error) {
    console.error(`Error cancelling order ${orderID}:`, error.message);
  }
}

// Returns null (not []) on failure, so callers can't mistake an error for "no positions"
async function fetchPositions() {
  try {
    const response = await fetch(`${pm.dataApiUrl}/positions?user=${pm.proxyAddress}`);
    if (!response.ok) {
      console.error('Error fetching positions: HTTP', response.status);
      return null;
    }
    const positions = await response.json();
    return Array.isArray(positions) ? positions : null;
  } catch (error) {
    console.error('Error fetching positions:', error.message);
    return null;
  }
}

async function fetchLiveNbaEvents() {
  const response = await fetch(`${pm.gammaApiUrl}/events?limit=500&active=true&closed=false`);
  if (!response.ok) {
    throw new Error(`Gamma API returned HTTP ${response.status}`);
  }
  const events = await response.json();
  return events.filter((event) => event.seriesSlug === 'nba' && event.live === true);
}

module.exports = {
  bestPrice,
  getOrderBook,
  getSpread,
  hasOpenOrders,
  buy,
  sell,
  cancelOrder,
  fetchPositions,
  fetchLiveNbaEvents,
};
