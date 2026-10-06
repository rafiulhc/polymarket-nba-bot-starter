const { MongoClient } = require('mongodb');
const config = require('./config');

let ordersCollection = null;

// Connects only if MONGODB_URI is set. The bot works the same without a database.
async function connectToDB() {
  if (!config.mongodbUri) {
    console.log('MONGODB_URI not set, order logging to MongoDB is disabled.');
    return;
  }
  const client = new MongoClient(config.mongodbUri);
  await client.connect();
  ordersCollection = client.db(config.mongodbDb).collection('orders');
  console.log(`Connected to MongoDB, logging orders to "${config.mongodbDb}.orders".`);
}

// Logging must never break trading, so errors are reported and swallowed
async function logOrder(entry) {
  if (!ordersCollection) return;
  try {
    await ordersCollection.insertOne({ ...entry, dryRun: config.dryRun, createdAt: new Date() });
  } catch (error) {
    console.error('Failed to log order to MongoDB:', error.message);
  }
}

module.exports = { connectToDB, logOrder };
