import crypto from 'crypto';
import { Router } from 'express';
import { cfg, coinsToKyat, todayMM, yesterdayMM } from './config.js';
import { q, tx, credit } from './db.js';
import { authMiddleware } from './auth.js';
import { isChannelMember, maskName, notifyAdmins } from './bot.js';

const router = Router();

const USER_COLS = `id, username, first_name, balance, total_earned, ads_today,
  to_char(ads_day,'YYYY-MM-DD') AS ads_day, last_ad_at, checkin_streak,
  to_char(last_checkin,'YYYY-MM-DD') AS last_checkin,
  to_char(last_spin,'YYYY-MM-DD') AS last_spin, channel_task_done, banned`;

async function getUser(id, client = null, lock = false) {
  const runner = client || { query: q };
  const { rows } = await runner.query(
    `SELECT ${USER_COLS} FROM users WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0];
}

const adsUsedToday = (u) => (u.ads_day === todayMM() ? u.ads_today : 0);
const randInt = (min, max) => crypto.randomInt(min, max + 1);

function publicUser(u) {
  const today = todayMM();
  return {
    id: String(u.id),
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

    await q(
      `UPDATE ad_events SET verified = TRUE WHERE id = (
         SELECT id FROM ad_events
         WHERE user_id=$1 AND verified=FALSE AND claimed=FALSE
           AND created_at > now() - interval '10 minutes'
         ORDER BY id DESC LIMIT 1)`,
      [userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('reward cb', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============ Public ============
router.get('/payouts', async (_req, res) => {
  const { rows } = await q(
    `SELECT w.id, w.amount_mmk, w.method, w.processed_at, w.proof_note, u.first_name, u.id AS uid
     FROM withdrawals w JOIN users u ON u.id=w.user_id
     WHERE w.status='paid' ORDER BY w.processed_at DESC LIMIT 30`
  );
  res.json({
    payouts: rows.map((r) => ({
      id: r.id,
      name: maskName({ first_name: r.first_name, id: r.uid }),
      amount: Number(r.amount_mmk),
      method: r.method,
      at: r.processed_at,
      ref: r.proof_note ? `…${r.proof_note.slice(-4)}` : null,
    })),
  });
});

router.get('/health', (_req, res) => res.json({ ok: true }));

// ============ Authenticated ============
router.use(authMiddleware);

router.get('/me', async (req, res) => {
  const u = await getUser(req.user.id);
  res.json({ user: publicUser(u), config: publicConfig() });
});

router.post('/ad/start', async (req, res) => {
  const u = await getUser(req.user.id);
  if (adsUsedToday(u) >= cfg.maxAdsPerDay) return res.status(429).json({ error: 'daily_limit' });
  if (u.last_ad_at) {
    const waited = (Date.now() - new Date(u.last_ad_at).getTime()) / 1000;
    if (waited < cfg.adCooldownSec) {
      return res
        .status(429)
        .json({ error: 'cooldown', waitSec: Math.ceil(cfg.adCooldownSec - waited) });
    }
  }
  const { rows } = await q('INSERT INTO ad_events (user_id) VALUES ($1) RETURNING id', [u.id]);
  res.json({ eventId: String(rows[0].id), mode: cfg.rewardMode });
});

router.post('/ad/claim', async (req, res) => {
  const eventId = Number(req.body?.eventId);
  if (!eventId) return res.status(400).json({ error: 'bad_request' });

  const result = await tx(async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM ad_events WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [eventId, req.user.id]
    );
    const ev = rows[0];
    if (!ev || ev.claimed) return { status: 404, body: { error: 'not_found' } };

    const ageMs = Date.now() - new Date(ev.created_at).getTime();
    if (ageMs > 15 * 60 * 1000) return { status: 410, body: { error: 'expired' } };

    if (cfg.rewardMode === 'callback') {
      if (!ev.verified) return { status: 202, body: { pending: true } };
    } else if (ageMs < cfg.minWatchSec * 1000) {
      return { status: 400, body: { error: 'too_fast' } };
    }

    const u = await getUser(req.user.id, c, true);
    if (adsUsedToday(u) >= cfg.maxAdsPerDay) {
      return { status: 429, body: { error: 'daily_limit' } };
    }

    const reward = cfg.rewardOptions[randInt(0, cfg.rewardOptions.length - 1)];
    await c.query('UPDATE ad_events SET claimed=TRUE WHERE id=$1', [eventId]);
    await c.query(
      `UPDATE users SET
         ads_today = CASE WHEN ads_day = $2::date THEN ads_today + 1 ELSE 1 END,
         ads_day = $2::date, last_ad_at = now()
       WHERE id=$1`,
      [u.id, todayMM()]
    );
    await credit(c, u.id, reward, 'ad', `event ${eventId}`);
    const fresh = await getUser(u.id, c);
    return { status: 200, body: { reward, user: publicUser(fresh) } };
  });

  res.status(result.status).json(result.body);
});

router.post('/checkin', async (req, res) => {
  const out = await tx(async (c) => {
    const u = await getUser(req.user.id, c, true);
    const today = todayMM();
    if (u.last_checkin === today) return { status: 400, body: { error: 'already' } };
    const streak = u.last_checkin === yesterdayMM() ? u.checkin_streak + 1 : 1;
    const reward = cfg.checkinBase + Math.min(streak - 1, 6);
    await c.query('UPDATE users SET checkin_streak=$2, last_checkin=$3::date WHERE id=$1', [
      u.id,
      streak,
      today,
    ]);
    await credit(c, u.id, reward, 'checkin', `streak ${streak}`);
    return { status: 200, body: { reward, streak, user: publicUser(await getUser(u.id, c)) } };
  });
  res.status(out.status).json(out.body);
});

router.post('/spin', async (req, res) => {
  const out = await tx(async (c) => {
    const u = await getUser(req.user.id, c, true);
    const today = todayMM();
    if (u.last_spin === today) return { status: 400, body: { error: 'already' } };
    const reward = randInt(cfg.spinMin, cfg.spinMax);
    await c.query('UPDATE users SET last_spin=$2::date WHERE id=$1', [u.id, today]);
    await credit(c, u.id, reward, 'spin');
    return { status: 200, body: { reward, user: publicUser(await getUser(u.id, c)) } };
  });
  res.status(out.status).json(out.body);
});

router.post('/task/channel', async (req, res) => {
  const member = await isChannelMember(req.user.id);
  if (!member) return res.status(400).json({ error: 'not_member' });
  const out = await tx(async (c) => {
    const u = await getUser(req.user.id, c, true);
    if (u.channel_task_done) return { status: 400, body: { error: 'already' } };
    await c.query('UPDATE users SET channel_task_done=TRUE WHERE id=$1', [u.id]);
    await credit(c, u.id, cfg.channelTaskReward, 'task', 'channel');
    return {
      status: 200,
      body: { reward: cfg.channelTaskReward, user: publicUser(await getUser(u.id, c)) },
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

  const out = await tx(async (c) => {
    const u = await getUser(req.user.id, c, true);
    if (Number(u.balance) < coins) return { status: 400, body: { error: 'insufficient' } };
    const pend = await c.query(
      `SELECT 1 FROM withdrawals WHERE user_id=$1 AND status='pending' LIMIT 1`,
      [u.id]
    );
    if (pend.rowCount) return { status: 400, body: { error: 'pending_exists' } };

    const mmk = coinsToKyat(coins);
    await c.query('UPDATE users SET balance = balance - $2 WHERE id=$1', [u.id, coins]);
    await c.query(
      'INSERT INTO transactions (user_id, amount, type, note) VALUES ($1,$2,$3,$4)',
      [u.id, -coins, 'withdraw', `${method} ${account}`]
    );
    const { rows } = await c.query(
      `INSERT INTO withdrawals (user_id, coins, amount_mmk, method, account)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [u.id, coins, mmk, method, account]
    );
    return {
      status: 200,
      body: { id: rows[0].id, amount: mmk, user: publicUser(await getUser(u.id, c)) },
      notify: `💸 ငွေထုတ်တောင်းဆိုမှုအသစ် #${rows[0].id}\n👤 ${u.first_name || ''} @${u.username || '-'} (${u.id})\n${mmk} ကျပ် (${coins} coin)\n${method}: ${account}\n\n/paid ${rows[0].id} <ref>\n/reject ${rows[0].id} <reason>`,
    };
  });

  if (out.notify) notifyAdmins(out.notify);
  res.status(out.status).json(out.body);
});

router.get('/withdrawals', async (req, res) => {
  const { rows } = await q(
    `SELECT id, coins, amount_mmk, method, status, proof_note, created_at, processed_at
     FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20`,
    [req.user.id]
  );
  res.json({
    items: rows.map((r) => ({
      id: r.id,
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
  const { rows } = await q(
    `SELECT id, first_name, total_earned FROM users WHERE banned=FALSE
     ORDER BY total_earned DESC LIMIT 10`
  );
  res.json({
    top: rows.map((r, i) => ({
      rank: i + 1,
      name: maskName(r),
      coins: Number(r.total_earned),
      me: String(r.id) === String(req.user.id),
    })),
  });
});

export default router;
