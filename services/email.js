const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { decrypt } = require('./encryption');

/**
 * Send an email on behalf of a customer.
 *
 * Supports two modes:
 *  1. Customer has their own Gmail app-password stored → send from their address
 *  2. Fall back to the platform SMTP account → send from platform address
 *
 * Customer Gmail credentials are stored encrypted in customer_profiles.gmail_app_password
 */

// Platform-level transporter (fallback)
let platformTransporter = null;

function getPlatformTransporter() {
  if (platformTransporter) return platformTransporter;
  if (!process.env.SMTP_HOST) return null;

  platformTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return platformTransporter;
}

// Customer-specific Gmail transporter
function getGmailTransporter(email, appPassword) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: appPassword },
  });
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

  // Try to get customer's own Gmail credentials
  const profileResult = await pool.query(
    'SELECT gmail_app_password FROM customer_profiles WHERE customer_id=$1',
    [customerId]
  );
  const profile = profileResult.rows[0];
  const customerResult = await pool.query('SELECT email, name FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];

  let transporter;
  let fromAddress;

  if (profile?.gmail_app_password) {
    const appPassword = decrypt(profile.gmail_app_password);
    if (appPassword) {
      transporter = getGmailTransporter(customer.email, appPassword);
      fromAddress = `${customer.name} <${customer.email}>`;
    }
  }

  if (!transporter) {
    transporter = getPlatformTransporter();
    if (!transporter) {
      throw new Error('Email not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS env vars, or add a Gmail app password for this customer.');
    }
    fromAddress = `${customer.name} via AI Assistant <${process.env.SMTP_USER}>`;
  }

  const mailOptions = {
    from: fromAddress,
    to,
    subject,
    text: body,
    cc: cc || undefined,
    bcc: bcc || undefined,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✉️ Email sent for customer ${customerId}: ${info.messageId}`);

  return { messageId: info.messageId, from: fromAddress };
}

module.exports = { sendEmail };
