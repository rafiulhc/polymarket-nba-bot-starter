const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh } = require('./helpers');

function fakeMongo({ insertError } = {}) {
  const inserted = [];
  return {
    inserted,
    module: {
      MongoClient: class {
        constructor(uri) { this.uri = uri; }
        async connect() {}
        db(name) {
          return {
            collection: (collection) => ({
              async insertOne(doc) {
                if (insertError) throw insertError;
                inserted.push({ name, collection, doc });
              },
            }),
          };
        }
      },
    },
  };
}

const loadDb = (env, mongo) => loadFresh('src/db.js', { env, stubs: { mongodb: mongo.module } });

describe('order audit log', () => {
  it('is turned off, and does nothing, when MONGODB_URI is not set', async () => {
    const mongo = fakeMongo();
    const db = loadDb({}, mongo);
    await db.connectToDB();
    await db.logOrder({ side: 'BUY' });

    assert.equal(mongo.inserted.length, 0);
  });

  it('writes each order with dryRun and createdAt to the orders collection', async () => {
    const mongo = fakeMongo();
    const db = loadDb({ MONGODB_URI: 'mongodb://test', MONGODB_DB: 'bot', DRY_RUN: 'true' }, mongo);
    await db.connectToDB();
    await db.logOrder({ side: 'BUY', price: 0.5 });

    const [{ name, collection, doc }] = mongo.inserted;
    assert.equal(name, 'bot');
    assert.equal(collection, 'orders');
    assert.equal(doc.side, 'BUY');
    assert.equal(doc.dryRun, true);
    assert.ok(doc.createdAt instanceof Date);
  });

  it('never throws when a write fails, so trading carries on', async () => {
    const mongo = fakeMongo({ insertError: new Error('cluster unavailable') });
    const db = loadDb({ MONGODB_URI: 'mongodb://test' }, mongo);
    await db.connectToDB();

    await assert.doesNotReject(db.logOrder({ side: 'SELL' }));
  });
});
