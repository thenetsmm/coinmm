import { Telegraf, Markup } from 'telegraf';
import { cfg, coinsToKyat } from './config.js';
import { users, transactions, withdrawals, tx, upsertUser } from './db.js';

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
  await upsertUser(u);

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
  const rows = await withdrawals().find({ status: 'pending' }).sort({ _id: 1 }).limit(30).toArray();
  if (!rows.length) return ctx.reply('စောင့်ဆိုင်းနေသော ငွေထုတ်တောင်းဆိုမှု မရှိပါ ✅');
  const us = await users()
    .find({ _id: { $in: rows.map((r) => r.user_id) } })
    .toArray();
  const byId = new Map(us.map((u) => [u._id, u]));
  const text = rows
    .map((w) => {
      const u = byId.get(w.user_id) || {};
      return (
        `#${w._id} | ${u.first_name || ''} @${u.username || '-'} (${w.user_id})\n` +
        `${w.amount_mmk} ကျပ် (${w.coins} coin) | ${w.method}: ${w.account}`
      );
    })
    .join('\n\n');
  return ctx.reply(text + '\n\n/paid <id> <ငွေလွှဲအမှတ်>\n/reject <id> <အကြောင်းရင်း>');
});

bot.command('paid', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, idStr, ...rest] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('အသုံးပြုပုံ: /paid <id> <ငွေလွှဲအမှတ်/မှတ်ချက်>');
  const note = rest.join(' ').trim() || null;

  const w = await withdrawals().findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'paid', processed_at: new Date(), proof_note: note } },
    { returnDocument: 'after' }
  );
  if (!w) return ctx.reply('ရှာမတွေ့ပါ သို့မဟုတ် ပြီးပြီးသား ဖြစ်ပါသည်။');

  const user = (await users().findOne({ _id: w.user_id })) || {};

  bot.telegram
    .sendMessage(
      w.user_id,
      `✅ သင့် ငွေထုတ်တောင်းဆိုမှု #${w._id} အောင်မြင်ပါသည်။\n💰 ${w.amount_mmk} ကျပ် → ${w.method}`
    )
    .catch(() => {});

  if (cfg.proofChannelId) {
    const last4 = note ? ` | Ref: …${note.slice(-4)}` : '';
    bot.telegram
      .sendMessage(
        cfg.proofChannelId,
        `✅ ငွေထုတ်ပြီး\n👤 ${maskName({ first_name: user.first_name, id: w.user_id })}\n💰 ${w.amount_mmk} ကျပ်\n🏦 ${w.method}${last4}\n🆔 #${w._id}`
      )
      .catch((e) => console.error('proof post failed', e.message));
  }
  return ctx.reply(`#${w._id} ကို paid အဖြစ် မှတ်ပြီးပါပြီ ✅`);
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, idStr, ...rest] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('အသုံးပြုပုံ: /reject <id> <အကြောင်းရင်း>');
  const reason = rest.join(' ').trim() || 'အကြောင်းမသိ';

  const w = await tx(async (session) => {
    const row = await withdrawals().findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'rejected', processed_at: new Date(), proof_note: reason } },
      { returnDocument: 'after', session }
    );
    if (!row) return null;
    // coin ပြန်အမ်း (total_earned မတိုးစေရ)
    await users().updateOne({ _id: row.user_id }, { $inc: { balance: row.coins } }, { session });
    await transactions().insertOne(
      {
        user_id: row.user_id,
        amount: row.coins,
        type: 'refund',
        note: `withdraw #${row._id} rejected`,
        created_at: new Date(),
      },
      { session }
    );
    return row;
  });
  if (!w) return ctx.reply('ရှာမတွေ့ပါ သို့မဟုတ် ပြီးပြီးသား ဖြစ်ပါသည်။');

  bot.telegram
    .sendMessage(
      w.user_id,
      `❌ သင့် ငွေထုတ်တောင်းဆိုမှု #${w._id} ကို ငြင်းပယ်လိုက်ပါသည်။\nအကြောင်းရင်း: ${reason}\n🪙 coin ${w.coins} ကို ပြန်အမ်းပေးပြီးပါပြီ။`
    )
    .catch(() => {});
  return ctx.reply(`#${w._id} ကို ငြင်းပယ်ပြီး coin ပြန်အမ်းပြီးပါပြီ ✅`);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [userCount, owed, pending, paid, ads24] = await Promise.all([
    users().countDocuments({}),
    users().aggregate([{ $group: { _id: null, t: { $sum: '$balance' } } }]).toArray(),
    withdrawals().countDocuments({ status: 'pending' }),
    withdrawals()
      .aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, t: { $sum: '$amount_mmk' } } }])
      .toArray(),
    transactions().countDocuments({ type: 'ad', created_at: { $gt: since } }),
  ]);
  const owedCoins = owed[0]?.t || 0;
  return ctx.reply(
    `👥 users: ${userCount}\n🪙 user များ လက်ကျန် coin: ${owedCoins} (≈ ${coinsToKyat(Number(owedCoins))} ကျပ်)\n` +
      `⏳ pending: ${pending}\n💸 ပေးချေပြီး: ${paid[0]?.t || 0} ကျပ်\n📺 ၂၄ နာရီအတွင်း ကြော်ငြာ: ${ads24}`
  );
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('/ban <user_id>');
  await users().updateOne({ _id: id }, { $set: { banned: true } });
  return ctx.reply(`${id} ကို ban လိုက်ပါပြီ`);
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('/unban <user_id>');
  await users().updateOne({ _id: id }, { $set: { banned: false } });
  return ctx.reply(`${id} ကို ban ပြန်ဖြေလိုက်ပါပြီ`);
});

bot.catch((err) => console.error('bot error', err));
