import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { cfg } from './config.js';
import { migrate } from './db.js';
import { bot } from './bot.js';
import router from './routes.js';

const required = ['BOT_TOKEN', 'DATABASE_URL', 'WEBAPP_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Environment variable မပြည့်စုံပါ:', missing.join(', '));
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(
  cors({
    origin: cfg.frontendUrl === '*' ? true : cfg.frontendUrl.split(',').map((s) => s.trim()),
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.get('/', (_req, res) => res.send('AdCoin MM backend is running'));

// Telegram webhook
const hookPath = `/telegram/${cfg.webhookSecret}`;
app.use(hookPath, bot.webhookCallback(hookPath));

app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api', router);

// async error → 500
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

async function main() {
  await migrate();
  console.log('DB ready');

  await bot.telegram.setMyCommands([{ command: 'start', description: 'Mini App ဖွင့်ရန်' }]);

  if (cfg.publicUrl) {
    await bot.telegram.setWebhook(`${cfg.publicUrl}${hookPath}`);
    console.log('Webhook set:', `${cfg.publicUrl}${hookPath}`);
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('PUBLIC_URL မရှိ၍ long-polling နဲ့ run နေသည်');
  }

  app.listen(cfg.port, () => console.log('Listening on', cfg.port));
}

main().catch((e) => {
  console.error('Startup failed', e);
  process.exit(1);
});
