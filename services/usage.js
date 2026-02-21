const { pool } = require('../db');

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // '2026-02'
}

const LIMITS = {
  whatsapp_messages: 200,
  call_minutes: 10,
  web_tasks: 20
};

async function getUsage(customerId) {
  const month = getCurrentMonth();
  const result = await pool.query(
    'SELECT * FROM usage_tracking WHERE customer_id = $1 AND month = $2',
    [customerId, month]
  );
  if (result.rows.length === 0) {
    const insert = await pool.query(
      'INSERT INTO usage_tracking (customer_id, month) VALUES ($1, $2) RETURNING *',
      [customerId, month]
    );
    return insert.rows[0];
  }
  return result.rows[0];
}

async function incrementUsage(customerId, type, amount = 1) {
  const month = getCurrentMonth();
  await pool.query(`
    INSERT INTO usage_tracking (customer_id, month, ${type})
    VALUES ($1, $2, $3)
    ON CONFLICT (customer_id, month)
    DO UPDATE SET ${type} = usage_tracking.${type} + $3, updated_at = NOW()
  `, [customerId, month, amount]);
}

async function checkLimit(customerId, type) {
  const usage = await getUsage(customerId);
  const current = parseFloat(usage[type]) || 0;
  const limit = LIMITS[type];
  return {
    current,
    limit,
    remaining: Math.max(0, limit - current),
    exceeded: current >= limit
  };
}

module.exports = { getUsage, incrementUsage, checkLimit, LIMITS, getCurrentMonth };
