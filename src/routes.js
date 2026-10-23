import crypto from 'crypto';
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { cfg, coinsToKyat, todayMM, yesterdayMM } from './config.js';
import { users, adEvents, transactions, withdrawals, tx, credit, nextSeq } from './db.js';
import { authMiddleware } from './auth.js';
import { isChannelMember, maskName, notifyAdmins } from './bot.js';

const router = Router();

const getUser = (id, session = undefined) => users().findOne({ _id: id }, { session });

const adsUsedToday = (u) => (u.ads_day === todayMM() ? u.ads_today : 0);
const randInt = (min, max) => crypto.randomInt(min, max + 1);

function publicUser(u) {
  const today = todayMM();
  return {
    id: String(u._id),
    firstName: u.first_name,
    balance: Number(u.balance),
    totalEarned: Number(u.total_earned),
    kyat: coinsToKyat(Number(u.balance)),
    adsToday: adsUsedToday(u),
    adsLeft: Math.max(0, cfg.maxAdsPerDay - adsUsedToday(u)),
    streak: u.checkin_streak,
    canCheckin: u.last_checkin !== today,
    canSpin: u.last_spin !== today,
    channelTaskDone: u.channel_task_done,
  };
}

function proofUrl() {
  const id = cfg.proofChannelId || '';
  if (/^@[A-Za-z0-9_]{4,}$/.test(id)) return `https://t.me/${id.slice(1)}`;
  return process.env.PROOF_CHANNEL_URL || '';
}

function publicConfig() {
  return {
    rewardOptions: cfg.rewardOptions,
    maxAdsPerDay: cfg.maxAdsPerDay,
    adCooldownSec: cfg.adCooldownSec,
    kyatPer1000Coins: cfg.kyatPer1000Coins,
    minWithdrawCoins: cfg.minWithdrawCoins,
    withdrawMethods: cfg.withdrawMethods,
    checkinBase: cfg.checkinBase,
    spinMin: cfg.spinMin,
    spinMax: cfg.spinMax,
    channelTaskReward: cfg.channelTaskReward,
    channelUrl: cfg.channelUrl,
    proofUrl: proofUrl(),
  };
}

// ============ Adsgram Reward URL (server-to-server) ============
// Adsgram dashboard ရဲ့ Reward URL: https://<backend>/api/adsgram/reward?userid=[userId]&secret=<ADSGRAM_REWARD_SECRET>
router.get('/adsgram/reward', async (req, res) => {
  try {
    const secret = String(req.query.secret || '');
    const a = Buffer.from(secret);
    const b = Buffer.from(cfg.rewardSecret);
    if (!cfg.rewardSecret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const userId = Number(req.query.userid);
    if (!userId) return res.status(400).json({ error: 'bad_userid' });

    await adEvents().findOneAndUpdate(
      {
        user_id: userId,
        verified: false,
        claimed: false,
        created_at: { $gt: new Date(Date.now() - 10 * 60 * 1000) },
      },
      { $set: { verified: true } },
      { sort: { _id: -1 } }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('reward cb', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============ Public ============
router.get('/payouts', async (_req, res) => {
  const rows = await withdrawals()
    .find({ status: 'paid' })
    .sort({ processed_at: -1 })
    .limit(30)
    .toArray();
  const us = await users()
    .find({ _id: { $in: [...new Set(rows.map((r) => r.user_id))] } })
    .toArray();
  const byId = new Map(us.map((u) => [u._id, u]));
  res.json({
    payouts: rows.map((r) => ({
      id: r._id,
      name: maskName({ first_name: byId.get(r.user_id)?.first_name, id: r.user_id }),
      amount: Number(r.amount_mmk),
      method: r.method,
      at: r.processed_at,
      ref: r.proof_note ? `…${r.proof_note.slice(-4)}` : null,
    })),
  });
});

router.get('/health', async (_req, res) => {
  try {
    await users().estimatedDocumentCount();
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false });
  }
});

// ============ Authenticated ============
router.use(authMiddleware);

router.get('/me', async (req, res) => {
  const u = await getUser(req.user._id);
  res.json({ user: publicUser(u), config: publicConfig() });
});

router.post('/ad/start', async (req, res) => {
  const u = await getUser(req.user._id);
  if (adsUsedToday(u) >= cfg.maxAdsPerDay) return res.status(429).json({ error: 'daily_limit' });
  if (u.last_ad_at) {
    const waited = (Date.now() - new Date(u.last_ad_at).getTime()) / 1000;
    if (waited < cfg.adCooldownSec) {
      return res
        .status(429)
        .json({ error: 'cooldown', waitSec: Math.ceil(cfg.adCooldownSec - waited) });
    }
  }
  const r = await adEvents().insertOne({
    user_id: u._id,
    created_at: new Date(),
    verified: false,
    claimed: false,
  });
  res.json({ eventId: String(r.insertedId), mode: cfg.rewardMode });
});

router.post('/ad/claim', async (req, res) => {
  const rawId = String(req.body?.eventId || '');
  if (!ObjectId.isValid(rawId)) return res.status(400).json({ error: 'bad_request' });
  const eventId = new ObjectId(rawId);

  const result = await tx(async (session) => {
    const ev = await adEvents().findOne({ _id: eventId, user_id: req.user._id }, { session });
    if (!ev || ev.claimed) return { status: 404, body: { error: 'not_found' } };

    const ageMs = Date.now() - new Date(ev.created_at).getTime();
    if (ageMs > 15 * 60 * 1000) return { status: 410, body: { error: 'expired' } };

    if (cfg.rewardMode === 'callback') {
      if (!ev.verified) return { status: 202, body: { pending: true } };
    } else if (ageMs < cfg.minWatchSec * 1000) {
      return { status: 400, body: { error: 'too_fast' } };
    }

    const u = await getUser(req.user._id, session);
    if (adsUsedToday(u) >= cfg.maxAdsPerDay) {
      return { status: 429, body: { error: 'daily_limit' } };
    }

    const reward = cfg.rewardOptions[randInt(0, cfg.rewardOptions.length - 1)];
    const today = todayMM();
    const claimed = await adEvents().updateOne(
      { _id: eventId, claimed: false },
      { $set: { claimed: true } },
      { session }
    );
    if (!claimed.modifiedCount) return { status: 404, body: { error: 'not_found' } };

    await users().updateOne(
      { _id: u._id },
      [
        {
          $set: {
            ads_today: {
              $cond: [{ $eq: ['$ads_day', today] }, { $add: ['$ads_today', 1] }, 1],
            },
            ads_day: today,
            last_ad_at: new Date(),
          },
        },
      ],
      { session }
    );
    await credit(session, u._id, reward, 'ad', `event ${rawId}`);
    const fresh = await getUser(u._id, session);
    return { status: 200, body: { reward, user: publicUser(fresh) } };
  });

  res.status(result.status).json(result.body);
});

router.post('/checkin', async (req, res) => {
  const out = await tx(async (session) => {
    const u = await getUser(req.user._id, session);
    const today = todayMM();
    if (u.last_checkin === today) return { status: 400, body: { error: 'already' } };
    const streak = u.last_checkin === yesterdayMM() ? u.checkin_streak + 1 : 1;
    const reward = cfg.checkinBase + Math.min(streak - 1, 6);
    await users().updateOne(
      { _id: u._id },
      { $set: { checkin_streak: streak, last_checkin: today } },
      { session }
    );
    await credit(session, u._id, reward, 'checkin', `streak ${streak}`);
    return {
      status: 200,
      body: { reward, streak, user: publicUser(await getUser(u._id, session)) },
    };
  });
  res.status(out.status).json(out.body);
});

router.post('/spin', async (req, res) => {
  const out = await tx(async (session) => {
    const u = await getUser(req.user._id, session);
    const today = todayMM();
    if (u.last_spin === today) return { status: 400, body: { error: 'already' } };
    const reward = randInt(cfg.spinMin, cfg.spinMax);
    await users().updateOne({ _id: u._id }, { $set: { last_spin: today } }, { session });
    await credit(session, u._id, reward, 'spin');
    return { status: 200, body: { reward, user: publicUser(await getUser(u._id, session)) } };
  });
  res.status(out.status).json(out.body);
});

router.post('/task/channel', async (req, res) => {
  const member = await isChannelMember(req.user._id);
  if (!member) return res.status(400).json({ error: 'not_member' });
  const out = await tx(async (session) => {
    const u = await getUser(req.user._id, session);
    if (u.channel_task_done) return { status: 400, body: { error: 'already' } };
    await users().updateOne({ _id: u._id }, { $set: { channel_task_done: true } }, { session });
    await credit(session, u._id, cfg.channelTaskReward, 'task', 'channel');
    return {
      status: 200,
      body: { reward: cfg.channelTaskReward, user: publicUser(await getUser(u._id, session)) },
    };
  });
  res.status(out.status).json(out.body);
});

router.post('/withdraw', async (req, res) => {
  const coins = Math.floor(Number(req.body?.coins));
  const method = String(req.body?.method || '');
  const account = String(req.body?.account || '').trim();

  if (!Number.isFinite(coins) || coins < cfg.minWithdrawCoins)
    return res.status(400).json({ error: 'below_min', min: cfg.minWithdrawCoins });
  if (!cfg.withdrawMethods.includes(method)) return res.status(400).json({ error: 'bad_method' });
  if (!/^[0-9+\s-]{7,20}$/.test(account)) return res.status(400).json({ error: 'bad_account' });

  const wid = await nextSeq('withdrawals');

  let out;
  try {
    out = await tx(async (session) => {
      const u = await getUser(req.user._id, session);
      if (Number(u.balance) < coins) return { status: 400, body: { error: 'insufficient' } };
      const pend = await withdrawals().findOne(
        { user_id: u._id, status: 'pending' },
        { session }
      );
      if (pend) return { status: 400, body: { error: 'pending_exists' } };

      const mmk = coinsToKyat(coins);
      const dec = await users().updateOne(
        { _id: u._id, balance: { $gte: coins } },
        { $inc: { balance: -coins } },
        { session }
      );
      if (!dec.modifiedCount) return { status: 400, body: { error: 'insufficient' } };

      await transactions().insertOne(
        {
          user_id: u._id,
          amount: -coins,
          type: 'withdraw',
          note: `${method} ${account}`,
          created_at: new Date(),
        },
        { session }
      );
      await withdrawals().insertOne(
        {
          _id: wid,
          user_id: u._id,
          coins,
          amount_mmk: mmk,
          method,
          account,
          status: 'pending',
          proof_note: null,
          created_at: new Date(),
          processed_at: null,
        },
        { session }
      );
      return {
        status: 200,
        body: { id: wid, amount: mmk, user: publicUser(await getUser(u._id, session)) },
        notify: `💸 ငွေထုတ်တောင်းဆိုမှုအသစ် #${wid}\n👤 ${u.first_name || ''} @${u.username || '-'} (${u._id})\n${mmk} ကျပ် (${coins} coin)\n${method}: ${account}\n\n/paid ${wid} <ref>\n/reject ${wid} <reason>`,
      };
    });
  } catch (e) {
    if (e?.code === 11000) return res.status(400).json({ error: 'pending_exists' });
    throw e;
  }

  if (out.notify) notifyAdmins(out.notify);
  res.status(out.status).json(out.body);
});

router.get('/withdrawals', async (req, res) => {
  const rows = await withdrawals()
    .find({ user_id: req.user._id })
    .sort({ _id: -1 })
    .limit(20)
    .toArray();
  res.json({
    items: rows.map((r) => ({
      id: r._id,
      coins: Number(r.coins),
      amount: Number(r.amount_mmk),
      method: r.method,
      status: r.status,
      note: r.status === 'rejected' ? r.proof_note : null,
      createdAt: r.created_at,
    })),
  });
});

router.get('/leaderboard', async (req, res) => {
  const rows = await users()
    .find({ banned: false })
    .sort({ total_earned: -1 })
    .limit(10)
    .toArray();
  res.json({
    top: rows.map((r, i) => ({
      rank: i + 1,
      name: maskName({ first_name: r.first_name, id: r._id }),
      coins: Number(r.total_earned),
      me: String(r._id) === String(req.user._id),
    })),
  });
});

export default router;
