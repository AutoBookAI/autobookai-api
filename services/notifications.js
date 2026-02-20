/**
 * Email notifications — welcome emails, weekly summaries, billing alerts.
 *
 * Uses Resend API (RESEND_API_KEY required).
 */

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  const { Resend } = require('resend');
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = () => process.env.RESEND_FROM || 'Kova <hello@kova.ai>';

async function sendWelcomeEmail(name, email) {
  const resend = getResend();
  if (!resend) {
    console.log('⚠️ Resend not configured — skipping welcome email');
    return;
  }

  try {
    await resend.emails.send({
      from: FROM(),
      to: [email],
      subject: 'Welcome to Kova — Your AI Assistant is Ready',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; color: #1a1a2e; margin: 0;">Welcome to Kova</h1>
            <p style="color: #666; margin-top: 8px;">Your personal AI assistant</p>
          </div>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">Hi ${name},</p>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            Thanks for signing up! Your Kova AI assistant is ready to help with phone calls,
            restaurant bookings, email management, travel planning, and more.
          </p>
          <div style="background: linear-gradient(135deg, #667eea, #764ba2); border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="color: #fff; font-size: 18px; font-weight: 600; margin: 0;">Getting Started</p>
            <p style="color: rgba(255,255,255,0.85); font-size: 14px; margin-top: 8px;">
              Text your assigned WhatsApp number to start chatting with Kova.
            </p>
          </div>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            <strong>Things you can ask Kova:</strong>
          </p>
          <ul style="color: #555; font-size: 14px; line-height: 1.8;">
            <li>"Call and book a table at Nobu for 4 tonight at 7pm"</li>
            <li>"Send an email to my boss about the meeting"</li>
            <li>"What's the weather like in Miami?"</li>
            <li>"Remind me to call mom at 5pm"</li>
            <li>"Search for flights to Paris next month"</li>
          </ul>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            Manage your preferences, connected apps, and billing at
            <a href="${process.env.FRONTEND_URL || 'https://kova.ai'}/portal/login" style="color: #667eea;">your dashboard</a>.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            Kova AI Assistant — Your personal concierge, powered by AI.
          </p>
        </div>
      `,
    });
    console.log(`📧 Welcome email sent to ${email}`);
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }
}

async function sendPaymentFailedEmail(name, email) {
  const resend = getResend();
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM(),
      to: [email],
      subject: 'Kova — Payment Issue with Your Subscription',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; color: #1a1a2e;">Payment Issue</h1>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">Hi ${name},</p>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            We had trouble processing your latest payment. Please update your payment method
            to keep your Kova assistant active.
          </p>
          <a href="${process.env.FRONTEND_URL || 'https://kova.ai'}/portal"
             style="display: inline-block; background: #667eea; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 16px;">
            Update Payment Method
          </a>
          <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
          <p style="color: #999; font-size: 12px;">Kova AI Assistant</p>
        </div>
      `,
    });
    console.log(`📧 Payment failed email sent to ${email}`);
  } catch (err) {
    console.error('Payment failed email error:', err.message);
  }
}

module.exports = { sendWelcomeEmail, sendPaymentFailedEmail };
