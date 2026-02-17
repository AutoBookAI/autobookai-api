#!/usr/bin/env node

/**
 * Test OpenClaw deployment on Railway.
 *
 * Usage:
 *   node scripts/test-deploy.js            # deploy, health-check, then tear down
 *   node scripts/test-deploy.js --keep     # deploy and keep running (don't tear down)
 *   node scripts/test-deploy.js --cleanup <serviceId>  # tear down an existing service
 *
 * Requires .env (or env vars) with:
 *   RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, ANTHROPIC_API_KEY,
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ENCRYPTION_KEY
 */

require('dotenv').config();
const crypto = require('crypto');
const { provisionOpenClawInstance, deprovisionOpenClawInstance, pollForHealth } = require('../services/railway');
const { checkOpenClawHealth } = require('../services/openclaw');

const args = process.argv.slice(2);
const keepAlive = args.includes('--keep');
const cleanupIdx = args.indexOf('--cleanup');

async function main() {
  // ── Cleanup mode ────────────────────────────────────────────────────────
  if (cleanupIdx !== -1) {
    const serviceId = args[cleanupIdx + 1];
    if (!serviceId) {
      console.error('Usage: node scripts/test-deploy.js --cleanup <serviceId>');
      process.exit(1);
    }
    console.log(`🗑️ Tearing down service: ${serviceId}`);
    await deprovisionOpenClawInstance(serviceId);
    console.log('Done.');
    return;
  }

  // ── Validate env ────────────────────────────────────────────────────────
  const required = ['RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID', 'ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    console.error('Copy .env.example → .env and fill in values.');
    process.exit(1);
  }

  // ── Deploy ──────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log('  OpenClaw Test Deployment');
  console.log('═══════════════════════════════════════════════\n');

  const testPassword = crypto.randomBytes(16).toString('hex');

  const startTime = Date.now();
  let result;
  try {
    result = await provisionOpenClawInstance({
      customerId:       0,
      customerName:     'Test User',
      anthropicApiKey:  process.env.ANTHROPIC_API_KEY,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || 'test-sid',
      twilioAuthToken:  process.env.TWILIO_AUTH_TOKEN || 'test-token',
      whatsappNumber:   '+10000000000',
      setupPassword:    testPassword,
    });
  } catch (err) {
    console.error(`\n❌ Provisioning failed: ${err.message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱  Total provisioning time: ${elapsed}s`);
  console.log(`   Service ID:  ${result.serviceId}`);
  console.log(`   Service URL: ${result.serviceUrl}`);
  console.log(`   Password:    ${testPassword}\n`);

  // ── Verify health ───────────────────────────────────────────────────────
  console.log('🔍 Running health check...');
  const healthy = await checkOpenClawHealth(result.serviceUrl);
  console.log(healthy ? '✅ Health check passed!' : '⚠️  Health check failed (instance may still be starting)');

  // ── Tear down (unless --keep) ───────────────────────────────────────────
  if (keepAlive) {
    console.log(`\n🟢 Instance left running. To tear down later:\n   node scripts/test-deploy.js --cleanup ${result.serviceId}\n`);
  } else {
    console.log('\n🗑️ Tearing down test instance...');
    await deprovisionOpenClawInstance(result.serviceId);
    console.log('✅ Test instance deleted.\n');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
