/**
 * Reminder service — schedules WhatsApp reminders for customers.
 *
 * Uses in-memory setTimeout for reminders within the next 24 hours.
 * On server restart, pending reminders are lost — for production,
 * a DB-based poller would be more robust.
 */

const { pool } = require('../db');

const scheduledReminders = new Map();

/**
 * Schedule a WhatsApp reminder.
 */
function scheduleReminder(customerId, message, time) {
  const delay = time.getTime() - Date.now();
  if (delay < 0) {
    console.warn(`⏰ Reminder time is in the past, sending immediately`);
    sendReminder(customerId, message);
    return;
  }

  // Cap at 24 hours (setTimeout max safe ~2B ms, but keep it practical)
  if (delay > 24 * 60 * 60 * 1000) {
    console.log(`⏰ Reminder scheduled for ${time.toISOString()} (>24h, stored in DB only)`);
    return;
  }

  const id = setTimeout(() => {
    sendReminder(customerId, message);
    scheduledReminders.delete(id);
  }, delay);

  scheduledReminders.set(id, { customerId, message, time });
  console.log(`⏰ Reminder set for ${time.toISOString()} (${Math.round(delay / 60000)}min)`);
}

async function sendReminder(customerId, message) {
  try {
    const result = await pool.query(
      'SELECT whatsapp_from FROM customers WHERE id=$1',
      [customerId]
    );
    const whatsappFrom = result.rows[0]?.whatsapp_from;
    if (!whatsappFrom) {
      console.error(`Cannot send reminder: no WhatsApp number for customer ${customerId}`);
      return;
    }

    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!fromNumber) return;

    await twilio.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${whatsappFrom}`,
      body: `⏰ Reminder: ${message}`,
    });

    console.log(`⏰ Reminder sent to ${whatsappFrom}: ${message}`);

    await pool.query(
      `INSERT INTO activity_log (customer_id, event_type, description) VALUES ($1, $2, $3)`,
      [customerId, 'reminder_sent', `Reminder: ${message}`]
    );
  } catch (err) {
    console.error('Failed to send reminder:', err.message);
  }
}

module.exports = { scheduleReminder };
