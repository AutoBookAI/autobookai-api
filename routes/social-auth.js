/**
 * Social OAuth authentication — Google, Facebook, LinkedIn, Apple, Instagram.
 *
 * Flow:
 *   1. GET /api/auth/:provider → redirect to provider's consent screen
 *   2. Provider redirects to GET /api/auth/:provider/callback
 *   3. Exchange code for token → fetch user profile → create or find customer
 *   4. Issue JWT → redirect to frontend with token
 *
 * Each provider needs env vars: {PROVIDER}_CLIENT_ID, {PROVIDER}_CLIENT_SECRET
 */

const router = require('express').Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:3000';
const CALLBACK_BASE = () => process.env.MASTER_API_URL || 'http://localhost:8080';

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userInfoUrl: 'https://graph.facebook.com/me?fields=id,name,email',
    scope: 'email',
    clientIdEnv: 'FACEBOOK_APP_ID',
    clientSecretEnv: 'FACEBOOK_APP_SECRET',
  },
  linkedin: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid profile email',
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    clientIdEnv: 'APPLE_CLIENT_ID',
    clientSecretEnv: 'APPLE_CLIENT_SECRET',
    responseMode: 'form_post',
  },
  instagram: {
    authUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    userInfoUrl: 'https://graph.instagram.com/me?fields=id,username',
    scope: 'user_profile',
    clientIdEnv: 'INSTAGRAM_CLIENT_ID',
    clientSecretEnv: 'INSTAGRAM_CLIENT_SECRET',
  },
  tiktok: {
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    userInfoUrl: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
    scope: 'user.info.basic',
    clientIdEnv: 'TIKTOK_CLIENT_KEY',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
    responseType: 'code',
  },
};

// GET /api/auth/:provider — redirect to OAuth consent screen
router.get('/:provider', (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(400).json({ error: 'Unknown provider' });

  const clientId = process.env[provider.clientIdEnv];
  if (!clientId) {
    const dest = req.query.signup === 'true' ? '/signup' : '/portal/login';
    return res.redirect(
      `${FRONTEND_URL()}${dest}?error=${encodeURIComponent(`${req.params.provider} login coming soon`)}`
    );
  }

  const redirectUri = `${CALLBACK_BASE()}/api/auth/social/${req.params.provider}/callback`;
  const state = req.query.signup === 'true' ? 'signup' : 'login';
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state,
  });

  // TikTok uses client_key instead of client_id
  if (req.params.provider === 'tiktok') {
    params.set('client_key', clientId);
  } else {
    params.set('client_id', clientId);
  }

  if (provider.responseMode) params.set('response_mode', provider.responseMode);

  res.redirect(`${provider.authUrl}?${params.toString()}`);
});

// GET /api/auth/:provider/callback — handle OAuth callback
router.get('/:provider/callback', async (req, res) => {
  const providerName = req.params.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) return res.redirect(`${FRONTEND_URL()}/portal/login?error=Unknown+provider`);

  const { code, state, error: oauthError } = req.query;
  if (oauthError || !code) {
    return res.redirect(`${FRONTEND_URL()}/portal/login?error=Authentication+cancelled`);
  }

  try {
    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    const redirectUri = `${CALLBACK_BASE()}/api/auth/social/${providerName}/callback`;

    // Exchange code for access token
    let tokenRes;
    if (providerName === 'tiktok') {
      // TikTok uses JSON body and different field names
      tokenRes = await axios.post(provider.tokenUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_key: clientId,
        client_secret: clientSecret,
      }, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
    } else {
      tokenRes = await axios.post(provider.tokenUrl, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      });
    }

    const accessToken = tokenRes.data.access_token;
    if (!accessToken) throw new Error('No access token received');

    // Fetch user profile
    let email, name;

    if (providerName === 'apple') {
      // Apple sends user info in the id_token (JWT), not via userinfo endpoint
      const idToken = tokenRes.data.id_token;
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
      email = payload.email;
      name = email.split('@')[0]; // Apple often doesn't provide name
    } else if (providerName === 'tiktok') {
      // TikTok returns user info in a nested data object
      const profileRes = await axios.get(provider.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = profileRes.data?.data?.user || {};
      name = userData.display_name || `tiktok_${userData.open_id?.slice(0, 8)}`;
      email = `${userData.open_id}@tiktok.user`; // TikTok doesn't expose email
    } else if (provider.userInfoUrl) {
      const profileRes = await axios.get(provider.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      email = profileRes.data.email;
      name = profileRes.data.name || profileRes.data.username || email.split('@')[0];
    }

    if (!email) throw new Error('Could not retrieve email from provider');

    // Find or create customer
    let customer;
    const existing = await pool.query('SELECT id, name, email FROM customers WHERE email=$1', [email]);

    if (existing.rows.length) {
      customer = existing.rows[0];
    } else {
      // New customer — create account (assigned to admin_id=1)
      const result = await pool.query(
        `INSERT INTO customers (admin_id, name, email, plan) VALUES (1, $1, $2, 'assistant') RETURNING id, name, email`,
        [name, email]
      );
      customer = result.rows[0];
      await pool.query('INSERT INTO customer_profiles (customer_id) VALUES ($1)', [customer.id]);
    }

    // Issue JWT
    const token = jwt.sign({ customerId: customer.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    // Redirect to frontend with token
    const isSignup = state === 'signup';
    const targetPath = isSignup ? '/portal' : '/portal';
    res.redirect(`${FRONTEND_URL()}${targetPath}?token=${token}&name=${encodeURIComponent(customer.name)}&email=${encodeURIComponent(customer.email)}&id=${customer.id}`);

  } catch (err) {
    console.error(`OAuth ${providerName} error:`, err.message);
    res.redirect(`${FRONTEND_URL()}/portal/login?error=${encodeURIComponent('Authentication failed. Please try again.')}`);
  }
});

module.exports = router;
