import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { cfg } from './config.js';
import { connect } from './db.js';
import { bot } from './bot.js';
import router from './routes.js';

const required = ['BOT_TOKEN', 'MONGODB_URI', 'WEBAPP_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Environment variable မပြည့်စုံပါ:', missing.join(', '));
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

// Auth က Authorization header (initData) နဲ့ဖြစ်ပြီး cookie မသုံးသဖြင့် CORS ကို ဖွင့်ထားနိုင်သည်
app.use(
  cors({
    origin: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  })
);

app.get('/', (_req, res) => res.send('AdCoin MM backend is running'));

// Telegram webhook
const hookPath = `/telegram/${cfg.webhookSecret}`;
app.use(bot.webhookCallback(hookPath));

// /api request log (ပြဿနာရှာရလွယ်ရန်)
app.use('/api', (req, res, next) => {
  if (req.method !== 'OPTIONS' && req.path !== '/health') {
    res.on('finish', () => console.log(`${req.method} /api${req.path} -> ${res.statusCode}`));
  }
  next();
});

app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api', router);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// async error → 500
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

async function main() {
  await connect();
  console.log('DB ready');

  // port ကို အရင်ဖွင့် (Render က port ရှာတွေ့ရန်)
  app.listen(cfg.port, () => console.log('Listening on', cfg.port));

  // Telegram setup မအောင်မြင်လည်း server မပျက်စေရ
  try {
    await bot.telegram.setMyCommands([{ command: 'start', description: 'Mini App ဖွင့်ရန်' }]);
    if (cfg.publicUrl) {
      await bot.telegram.setWebhook(`${cfg.publicUrl}${hookPath}`);
      console.log('Webhook set:', `${cfg.publicUrl}${hookPath}`);
    } else {
      await bot.telegram.deleteWebhook();
      bot.launch();
      console.log('PUBLIC_URL မရှိ၍ long-polling နဲ့ run နေသည်');
    }
  } catch (e) {
    console.error('Telegram setup failed:', e.message);
  }
}

main().catch((e) => {
  console.error('Startup failed', e);
  process.exit(1);
});
