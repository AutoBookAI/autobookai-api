const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { pool } = require('../db');
const { decrypt } = require('./encryption');

/**
 * Send an email on behalf of a customer.
 *
 * Primary:  Resend HTTP API (port 443 — works on all cloud platforms)
 * Fallback: Customer's own Gmail app-password via nodemailer (if configured)
 *
 * SMTP over ports 587/465 is blocked on Railway and many cloud hosts.
 * Resend uses HTTPS so it always works.
 */

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/**
 * Send an email.
 *
 * @param {number} customerId
 * @param {object} opts - { to, subject, body, cc?, bcc? }
 * @returns {{ messageId, from }}
 */
async function sendEmail(customerId, { to, subject, body, cc, bcc }) {
  if (!to || !subject || !body) {
    throw new Error('Missing required fields: to, subject, body');
  }

  const profileResult = await pool.query(
    'SELECT gmail_app_password FROM customer_profiles WHERE customer_id=$1',
    [customerId]
  );
  const profile = profileResult.rows[0];
  const customerResult = await pool.query('SELECT email, name FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];

  // Option 1: Customer has their own Gmail app-password → use nodemailer
  if (profile?.gmail_app_password) {
    const appPassword = decrypt(profile.gmail_app_password, customerId);
    if (appPassword) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: customer.email, pass: appPassword },
      });
      const fromAddress = `${customer.name} <${customer.email}>`;
      const info = await transporter.sendMail({
        from: fromAddress, to, subject, text: body,
        cc: cc || undefined, bcc: bcc || undefined,
      });
      console.log(`✉️ Email sent via customer Gmail for ${customerId}: ${info.messageId}`);
      return { messageId: info.messageId, from: fromAddress };
    }
  }

  // Option 2: Resend HTTP API (platform-level, always works on cloud)
  const resend = getResend();
  if (resend) {
    const fromAddress = process.env.RESEND_FROM || 'AI Assistant <assistant@autobookai.com>';
    const result = await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      text: body,
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
      replyTo: customer.email,
    });

    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }

    console.log(`✉️ Email sent via Resend for customer ${customerId}: ${result.data.id}`);
    return { messageId: result.data.id, from: fromAddress };
  }

  throw new Error('Email not configured. Set RESEND_API_KEY env var, or add a Gmail app password for this customer.');
}

module.exports = { sendEmail };
