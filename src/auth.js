import crypto from 'crypto';
import { cfg } from './config.js';
import { upsertUser } from './db.js';

// Telegram Mini App initData ကို HMAC နဲ့ စစ်ဆေးခြင်း
export function verifyInitData(initData) {
  if (!initData || !cfg.botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 24 * 3600) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const tgUser = verifyInitData(initData);
    if (!tgUser) return res.status(401).json({ error: 'unauthorized' });
    const user = await upsertUser(tgUser);
    if (user.banned) return res.status(403).json({ error: 'banned' });
    req.user = user;
    next();
  } catch (e) {
    console.error('auth error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
