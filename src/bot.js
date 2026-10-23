import { Telegraf, Markup } from 'telegraf';
import { cfg, coinsToKyat } from './config.js';
import { q, tx } from './db.js';

export const bot = new Telegraf(cfg.botToken || 'missing-token');

const isAdmin = (id) => cfg.adminIds.includes(Number(id));

export async function isChannelMember(userId) {
  if (!cfg.channelId) return true; // channel မသတ်မှတ်ရင် စစ်မနေ
  try {
    const m = await bot.telegram.getChatMember(cfg.channelId, userId);
    return ['member', 'administrator', 'creator'].includes(m.status);
  } catch (e) {
    console.error('getChatMember failed (bot ကို channel admin ခန့်ထားပါ):', e.message);
    return false;
  }
}

export function maskName(user) {
  const first = (user.first_name || 'User').trim();
  const head = Array.from(first)[0] || 'U';
  const tail = String(user.id).slice(-3);
  return `${head}•••${tail}`;
}

export async function notifyAdmins(text) {
  for (const id of cfg.adminIds) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (e) {
      console.error('notify admin failed', id, e.message);
    }
  }
}

// ---------- /start ----------
bot.start(async (ctx) => {
  const u = ctx.from;
  await q(
    `INSERT INTO users (id, username, first_name) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
    [u.id, u.username || null, u.first_name || null]
  );

  const member = await isChannelMember(u.id);

  if (!member) {
    return ctx.reply(
      `👋 မင်္ဂလာပါ ${u.first_name || ''}!\n\n` +
        `📢 သတင်းအချက်အလက်များ သိရှိနိုင်ရန် ကျွန်ုပ်တို့ channel ကို join ပေးပါ။\n\n` +
        `Join ပြီးပါက /start ကို ထပ်မံနှိပ်ပါ။`,
      Markup.inlineKeyboard([[Markup.button.url('📢 Channel Join မည်', cfg.channelUrl)]])
    );
  }

  return ctx.reply(
    `✅ ကျေးဇူးတင်ပါတယ် ${u.first_name || ''}!\n\n` +
      `🎮 အောက်ပါခလုတ်ကို နှိပ်ပြီး Mini App ထဲဝင်ကာ ကြော်ငြာကြည့်၍ coin ရယူနိုင်ပါပြီ။`,
    Markup.inlineKeyboard([[Markup.button.webApp('🎮 Mini App ဖွင့်မည်', cfg.webappUrl)]])
  );
});

bot.help((ctx) =>
  ctx.reply('/start - Mini App ဖွင့်ရန်\n\nမေးစရာရှိပါက channel တွင် ဆက်သွယ်နိုင်ပါသည်။')
);

// ---------- Admin commands ----------
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { rows } = await q(
    `SELECT w.*, u.first_name, u.username FROM withdrawals w
     JOIN users u ON u.id = w.user_id WHERE w.status='pending' ORDER BY w.id LIMIT 30`
  );
  if (!rows.length) return ctx.reply('စောင့်ဆိုင်းနေသော ငွေထုတ်တောင်းဆိုမှု မရှိပါ ✅');
  const text = rows
    .map(
      (w) =>
        `#${w.id} | ${w.first_name || ''} @${w.username || '-'} (${w.user_id})\n` +
        `${w.amount_mmk} ကျပ် (${w.coins} coin) | ${w.method}: ${w.account}`
    )
    .join('\n\n');
  return ctx.reply(text + '\n\n/paid <id> <ငွေလွှဲအမှတ်>\n/reject <id> <အကြောင်းရင်း>');
});

bot.command('paid', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, idStr, ...rest] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('အသုံးပြုပုံ: /paid <id> <ငွေလွှဲအမှတ်/မှတ်ချက်>');
  const note = rest.join(' ').trim() || null;

  const w = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE withdrawals SET status='paid', processed_at=now(), proof_note=$2
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, note]
    );
    return rows[0];
  });
  if (!w) return ctx.reply('ရှာမတွေ့ပါ သို့မဟုတ် ပြီးပြီးသား ဖြစ်ပါသည်။');

  const { rows } = await q('SELECT * FROM users WHERE id=$1', [w.user_id]);
  const user = rows[0];

  bot.telegram
    .sendMessage(
      w.user_id,
      `✅ သင့် ငွေထုတ်တောင်းဆိုမှု #${w.id} အောင်မြင်ပါသည်။\n💰 ${w.amount_mmk} ကျပ် → ${w.method}`
    )
    .catch(() => {});

  if (cfg.proofChannelId) {
    const last4 = note ? ` | Ref: …${note.slice(-4)}` : '';
    bot.telegram
      .sendMessage(
        cfg.proofChannelId,
        `✅ ငွေထုတ်ပြီး\n👤 ${maskName(user)}\n💰 ${w.amount_mmk} ကျပ်\n🏦 ${w.method}${last4}\n🆔 #${w.id}`
      )
      .catch((e) => console.error('proof post failed', e.message));
  }
  return ctx.reply(`#${w.id} ကို paid အဖြစ် မှတ်ပြီးပါပြီ ✅`);
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, idStr, ...rest] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('အသုံးပြုပုံ: /reject <id> <အကြောင်းရင်း>');
  const reason = rest.join(' ').trim() || 'အကြောင်းမသိ';

  const w = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE withdrawals SET status='rejected', processed_at=now(), proof_note=$2
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, reason]
    );
    const row = rows[0];
    if (!row) return null;
    // coin ပြန်အမ်း (total_earned မတိုးစေရ)
    await c.query('UPDATE users SET balance = balance + $2 WHERE id=$1', [row.user_id, row.coins]);
    await c.query(
      'INSERT INTO transactions (user_id, amount, type, note) VALUES ($1,$2,$3,$4)',
      [row.user_id, row.coins, 'refund', `withdraw #${row.id} rejected`]
    );
    return row;
  });
  if (!w) return ctx.reply('ရှာမတွေ့ပါ သို့မဟုတ် ပြီးပြီးသား ဖြစ်ပါသည်။');

  bot.telegram
    .sendMessage(
      w.user_id,
      `❌ သင့် ငွေထုတ်တောင်းဆိုမှု #${w.id} ကို ငြင်းပယ်လိုက်ပါသည်။\nအကြောင်းရင်း: ${reason}\n🪙 coin ${w.coins} ကို ပြန်အမ်းပေးပြီးပါပြီ။`
    )
    .catch(() => {});
  return ctx.reply(`#${w.id} ကို ငြင်းပယ်ပြီး coin ပြန်အမ်းပြီးပါပြီ ✅`);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { rows } = await q(
    `SELECT
       (SELECT count(*) FROM users) AS users,
       (SELECT coalesce(sum(balance),0) FROM users) AS owed_coins,
       (SELECT count(*) FROM withdrawals WHERE status='pending') AS pending,
       (SELECT coalesce(sum(amount_mmk),0) FROM withdrawals WHERE status='paid') AS paid_mmk,
       (SELECT count(*) FROM transactions WHERE type='ad' AND created_at > now() - interval '24 hours') AS ads_24h`
  );
  const s = rows[0];
  return ctx.reply(
    `👥 users: ${s.users}\n🪙 user များ လက်ကျန် coin: ${s.owed_coins} (≈ ${coinsToKyat(Number(s.owed_coins))} ကျပ်)\n` +
      `⏳ pending: ${s.pending}\n💸 ပေးချေပြီး: ${s.paid_mmk} ကျပ်\n📺 ၂၄ နာရီအတွင်း ကြော်ငြာ: ${s.ads_24h}`
  );
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('/ban <user_id>');
  await q('UPDATE users SET banned = TRUE WHERE id=$1', [id]);
  return ctx.reply(`${id} ကို ban လိုက်ပါပြီ`);
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('/unban <user_id>');
  await q('UPDATE users SET banned = FALSE WHERE id=$1', [id]);
  return ctx.reply(`${id} ကို ban ပြန်ဖြေလိုက်ပါပြီ`);
});

bot.catch((err) => console.error('bot error', err));
