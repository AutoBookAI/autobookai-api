/**
 * Google Calendar integration.
 *
 * Supports two auth modes:
 *  1. Service account (platform-level, for creating events on public calendars)
 *  2. OAuth2 per-customer (stored encrypted in customer_profiles.google_calendar_token)
 *
 * For MVP: uses OAuth2 tokens. Customers authorize via a one-time OAuth flow
 * and we store their refresh token encrypted.
 */

const { google } = require('googleapis');
const { pool } = require('../db');
const { decrypt, encrypt } = require('./encryption');

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.FRONTEND_URL}/api/tools/calendar/callback`
  );
}

/**
 * Get an authenticated calendar client for a customer.
 * Reads their stored OAuth token from the database.
 */
async function getCalendarClient(customerId) {
  const result = await pool.query(
    'SELECT google_calendar_token FROM customer_profiles WHERE customer_id=$1',
    [customerId]
  );

  const encryptedToken = result.rows[0]?.google_calendar_token;
  if (!encryptedToken) {
    throw new Error('Google Calendar not connected. Customer needs to authorize via OAuth first.');
  }

  // Note: google_calendar_token is currently shared with openclaw password storage.
  // We'll need a dedicated column once calendar OAuth is live.
  // For now, try to parse as JSON (OAuth token) — if it fails, it's the openclaw password.
  const decrypted = decrypt(encryptedToken);
  let tokens;
  try {
    tokens = JSON.parse(decrypted);
  } catch {
    throw new Error('Google Calendar not connected. Stored token is not a Calendar OAuth token.');
  }

  const auth = getOAuth2Client();
  auth.setCredentials(tokens);

  // Refresh token if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    const { credentials } = await auth.refreshAccessToken();
    auth.setCredentials(credentials);
    // Save refreshed token
    await pool.query(
      'UPDATE customer_profiles SET google_calendar_token=$1 WHERE customer_id=$2',
      [encrypt(JSON.stringify(credentials)), customerId]
    );
  }

  return google.calendar({ version: 'v3', auth });
}

/**
 * Generate an OAuth authorization URL for a customer.
 */
function getAuthUrl(customerId) {
  const auth = getOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: String(customerId),
    prompt: 'consent',
  });
}

/**
 * Exchange OAuth code for tokens and store them.
 */
async function handleOAuthCallback(code, customerId) {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);
  await pool.query(
    'UPDATE customer_profiles SET google_calendar_token=$1 WHERE customer_id=$2',
    [encrypt(JSON.stringify(tokens)), customerId]
  );
  return tokens;
}

/**
 * List upcoming events.
 */
async function listEvents(customerId, { maxResults = 10, timeMin } = {}) {
  const calendar = await getCalendarClient(customerId);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin || new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items || []).map(e => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    description: e.description,
  }));
}

/**
 * Create a new calendar event.
 */
async function createEvent(customerId, { summary, start, end, location, description, timezone }) {
  if (!summary || !start) throw new Error('Missing required: summary, start');

  // Use provided timezone, or look up from customer profile, or fall back to default
  let tz = timezone;
  if (!tz) {
    const tzResult = await pool.query(
      'SELECT timezone FROM customer_profiles WHERE customer_id=$1',
      [customerId]
    );
    tz = tzResult.rows[0]?.timezone || 'America/Los_Angeles';
  }

  const calendar = await getCalendarClient(customerId);
  const event = {
    summary,
    location: location || undefined,
    description: description || undefined,
    start: { dateTime: start, timeZone: tz },
    end:   { dateTime: end || addHour(start), timeZone: tz },
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
  });

  return {
    id: res.data.id,
    summary: res.data.summary,
    start: res.data.start?.dateTime,
    end: res.data.end?.dateTime,
    htmlLink: res.data.htmlLink,
  };
}

/**
 * Delete a calendar event.
 */
async function deleteEvent(customerId, eventId) {
  const calendar = await getCalendarClient(customerId);
  await calendar.events.delete({ calendarId: 'primary', eventId });
  return { deleted: true };
}

function addHour(isoString) {
  const d = new Date(isoString);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  listEvents,
  createEvent,
  deleteEvent,
};
