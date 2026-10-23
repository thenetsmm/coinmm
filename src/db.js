import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'adcoin';

export const client = new MongoClient(uri || 'mongodb://127.0.0.1:27017', {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 15000,
});

let _db = null;
export const db = () => {
  if (!_db) throw new Error('DB not connected');
  return _db;
};

// collection shortcuts
export const users = () => db().collection('users');
export const adEvents = () => db().collection('ad_events');
export const transactions = () => db().collection('transactions');
export const withdrawals = () => db().collection('withdrawals');
const counters = () => db().collection('counters');

export async function connect() {
  await client.connect();
  _db = client.db(dbName);
  await createIndexes();
}

async function createIndexes() {
  await adEvents().createIndex({ user_id: 1, _id: -1 });
  // ad event မှတ်တမ်းကို ၁ ရက်ကြာလျှင် အလိုအလျောက် ဖျက်
  await adEvents().createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 });
  await transactions().createIndex({ user_id: 1, _id: -1 });
  await transactions().createIndex({ type: 1, created_at: -1 });
  await withdrawals().createIndex({ status: 1, _id: 1 });
  await withdrawals().createIndex({ user_id: 1, _id: -1 });
  // user တစ်ယောက်ကို pending တစ်ခုထက်ပိုမရ (race condition ကာကွယ်)
  await withdrawals().createIndex(
    { user_id: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_user' }
  );
  await users().createIndex({ banned: 1, total_earned: -1 });
}

// Transaction (Atlas / replica set လိုအပ်သည်။ conflict ဖြစ်လျှင် အလိုအလျောက် retry)
export async function tx(fn) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}

// ငွေထုတ်တောင်းဆိုမှု #id အတွက် အစဉ်လိုက်ဂဏန်း
export async function nextSeq(name) {
  const doc = await counters().findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return doc.seq;
}

export async function upsertUser(tgUser) {
  return users().findOneAndUpdate(
    { _id: tgUser.id },
    {
      $set: { username: tgUser.username || null, first_name: tgUser.first_name || null },
      $setOnInsert: {
        balance: 0,
        total_earned: 0,
        ads_today: 0,
        ads_day: null,
        last_ad_at: null,
        checkin_streak: 0,
        last_checkin: null,
        last_spin: null,
        channel_task_done: false,
        banned: false,
        created_at: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
}

// coin ပေါင်းထည့်ပြီး ledger မှတ် (session = transaction session)
export async function credit(session, userId, amount, type, note = null) {
  await users().updateOne(
    { _id: userId },
    { $inc: { balance: amount, total_earned: amount } },
    { session }
  );
  await transactions().insertOne(
    { user_id: userId, amount, type, note, created_at: new Date() },
    { session }
  );
}
