import pg from 'pg';

const useSsl = process.env.DATABASE_SSL !== 'false';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 8,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance BIGINT NOT NULL DEFAULT 0,
      total_earned BIGINT NOT NULL DEFAULT 0,
      ads_today INT NOT NULL DEFAULT 0,
      ads_day DATE,
      last_ad_at TIMESTAMPTZ,
      checkin_streak INT NOT NULL DEFAULT 0,
      last_checkin DATE,
      last_spin DATE,
      channel_task_done BOOLEAN NOT NULL DEFAULT FALSE,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ad_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      claimed BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_ad_events_user ON ad_events(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      amount BIGINT NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      coins BIGINT NOT NULL,
      amount_mmk BIGINT NOT NULL,
      method TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      proof_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, id);
  `);
}

// transaction client ထဲမှာ coin ပေါင်းထည့်ပြီး ledger မှတ်
export async function credit(client, userId, amount, type, note = null) {
  await client.query(
    'UPDATE users SET balance = balance + $2, total_earned = total_earned + $2 WHERE id = $1',
    [userId, amount]
  );
  await client.query(
    'INSERT INTO transactions (user_id, amount, type, note) VALUES ($1,$2,$3,$4)',
    [userId, amount, type, note]
  );
}
