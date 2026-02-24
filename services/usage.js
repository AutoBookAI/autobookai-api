const { pool } = require('../db');

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // '2026-02'
}

function getToday() {
  return new Date().toISOString().split('T')[0]; // '2026-02-23'
}

// Daily limits for messages and call minutes. Web tasks are unlimited.
const LIMITS = {
  whatsapp_messages: 30,  // per day
  call_minutes: 60,       // per day
};

/**
 * Get monthly usage record (for backward compatibility and call_minutes).
 */
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

/**
 * Get daily usage for a specific type.
 * Counts rows inserted today in usage_tracking via created_at/updated_at.
 * For daily tracking we use a separate query approach.
 */
async function getDailyUsage(customerId, type) {
  const today = getToday();
  // We track daily usage by querying the monthly record's daily sub-counts
  // Since the schema uses a single monthly row, we need a daily tracking approach.
  // We'll use the activity_log to count today's messages and web tasks.

  if (type === 'whatsapp_messages') {
    const result = await pool.query(
      `SELECT COUNT(*) FROM activity_log
       WHERE customer_id = $1 AND event_type = 'message'
       AND DATE(created_at) = $2`,
      [customerId, today]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  if (type === 'web_tasks') {
    const result = await pool.query(
      `SELECT COUNT(*) FROM activity_log
       WHERE customer_id = $1 AND event_type IN ('web_task', 'openclaw_task')
       AND DATE(created_at) = $2`,
      [customerId, today]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  // call_minutes — now daily, count from activity_log
  if (type === 'call_minutes') {
    const result = await pool.query(
      `SELECT COALESCE(SUM((metadata::json->>'duration_minutes')::numeric), 0) as total
       FROM activity_log
       WHERE customer_id = $1 AND event_type = 'phone_call'
       AND DATE(created_at) = $2`,
      [customerId, today]
    );
    return parseFloat(result.rows[0].total) || 0;
  }

  return 0;
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

/**
 * Check if a customer has exceeded their limit.
 * Messages and call minutes use DAILY limits.
 * Web tasks are unlimited (no limit check).
 */
async function checkLimit(customerId, type) {
  // Web tasks are unlimited — never exceeded
  if (type === 'web_tasks') {
    return { current: 0, limit: Infinity, remaining: Infinity, exceeded: false, period: 'unlimited' };
  }

  const limit = LIMITS[type];

  // All limits are now daily
  const current = await getDailyUsage(customerId, type);
  return {
    current,
    limit,
    remaining: Math.max(0, limit - current),
    exceeded: current >= limit,
    period: 'daily'
  };
}

module.exports = { getUsage, getDailyUsage, incrementUsage, checkLimit, LIMITS, getCurrentMonth, getToday };
