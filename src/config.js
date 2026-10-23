import 'dotenv/config';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
};
const list = (v, d) =>
  (v ?? d)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const cfg = {
  port: num(process.env.PORT, 3000),
  botToken: process.env.BOT_TOKEN || '',
  webappUrl: process.env.WEBAPP_URL || '',
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  webhookSecret: process.env.WEBHOOK_SECRET || 'webhook',
  channelId: process.env.CHANNEL_ID || '',
  channelUrl: process.env.CHANNEL_URL || '',
  proofChannelId: process.env.PROOF_CHANNEL_ID || '',
  adminIds: list(process.env.ADMIN_IDS, '').map(Number),
  frontendUrl: process.env.FRONTEND_URL || '*',

  rewardMode: process.env.REWARD_MODE === 'client' ? 'client' : 'callback',
  rewardSecret: process.env.ADSGRAM_REWARD_SECRET || '',
  rewardOptions: list(process.env.REWARD_OPTIONS, '15,20').map(Number).filter((n) => n > 0),
  maxAdsPerDay: num(process.env.MAX_ADS_PER_DAY, 40),
  adCooldownSec: num(process.env.AD_COOLDOWN_SEC, 20),
  minWatchSec: num(process.env.MIN_WATCH_SEC, 12),

  kyatPer1000Coins: num(process.env.KYAT_PER_1000_COINS, 100),
  minWithdrawCoins: num(process.env.MIN_WITHDRAW_COINS, 10000),
  withdrawMethods: list(process.env.WITHDRAW_METHODS, 'KBZPay,WavePay,AYA Pay,CB Pay'),
  checkinBase: num(process.env.DAILY_CHECKIN_BASE, 5),
  spinMin: num(process.env.SPIN_MIN, 3),
  spinMax: num(process.env.SPIN_MAX, 12),
  channelTaskReward: num(process.env.CHANNEL_TASK_REWARD, 50),
};

export function coinsToKyat(coins) {
  return Math.floor((coins / 1000) * cfg.kyatPer1000Coins);
}

// မြန်မာစံတော်ချိန် (UTC+6:30) အရ ယနေ့ရက်စွဲ
export function todayMM() {
  return new Date(Date.now() + 6.5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function yesterdayMM() {
  return new Date(Date.now() + 6.5 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
}
