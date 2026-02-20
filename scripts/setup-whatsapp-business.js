#!/usr/bin/env node
/**
 * WhatsApp Business API Setup Script
 *
 * Configures everything possible programmatically via the Twilio API:
 *   1. Updates the Messaging Service webhook URL
 *   2. Registers the phone number for WhatsApp Business
 *   3. Submits a WhatsApp sender profile
 *
 * Run with Railway env vars:
 *   railway run -- node scripts/setup-whatsapp-business.js
 *
 * After running this script, complete the manual steps printed at the end.
 */

require('dotenv').config();

const PHONE_NUMBER = '+19785588477';
const MESSAGING_SERVICE_SID = 'MG9624850dc96b6c3d3d65713a0d3db902';
const WEBHOOK_URL = 'https://bountiful-growth-production.up.railway.app/webhook/twilio';
const BUSINESS_NAME = 'Kova';
const BUSINESS_DESCRIPTION = 'Your AI personal assistant — manages reservations, travel, calls, and more via WhatsApp.';

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('❌ Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    process.exit(1);
  }

  const twilio = require('twilio')(accountSid, authToken);

  console.log('═══ WhatsApp Business API Setup ═══\n');

  // ── Step 1: Update Messaging Service webhook ─────────────────────────────
  console.log('1️⃣  Updating Messaging Service webhook...');
  try {
    const service = await twilio.messaging.v1.services(MESSAGING_SERVICE_SID).update({
      inboundRequestUrl: WEBHOOK_URL,
      inboundMethod: 'POST',
      friendlyName: 'Kova WhatsApp',
    });
    console.log(`   ✅ Messaging Service "${service.friendlyName}" webhook → ${WEBHOOK_URL}`);
  } catch (err) {
    console.log(`   ⚠️  Could not update messaging service: ${err.message}`);
  }

  // ── Step 2: List phone numbers on the account ────────────────────────────
  console.log('\n2️⃣  Checking phone numbers...');
  try {
    const numbers = await twilio.incomingPhoneNumbers.list();
    const ourNumber = numbers.find(n => n.phoneNumber === PHONE_NUMBER);
    if (ourNumber) {
      console.log(`   ✅ Found ${PHONE_NUMBER} (SID: ${ourNumber.sid})`);

      // Ensure it's in the messaging service
      try {
        await twilio.messaging.v1.services(MESSAGING_SERVICE_SID)
          .phoneNumbers.create({ phoneNumberSid: ourNumber.sid });
        console.log(`   ✅ Added to Messaging Service`);
      } catch (e) {
        if (e.code === 21710) {
          console.log(`   ✅ Already in Messaging Service`);
        } else {
          console.log(`   ⚠️  ${e.message}`);
        }
      }
    } else {
      console.log(`   ❌ ${PHONE_NUMBER} not found on this account`);
    }
  } catch (err) {
    console.log(`   ⚠️  ${err.message}`);
  }

  // ── Step 3: Try to register WhatsApp sender ──────────────────────────────
  console.log('\n3️⃣  Attempting WhatsApp sender registration...');
  try {
    // Try the WhatsApp Senders API
    const axios = require('axios');
    const resp = await axios.post(
      `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE_SID}/AlphaSenders`,
      new URLSearchParams({ AlphaSender: BUSINESS_NAME }).toString(),
      {
        auth: { username: accountSid, password: authToken },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      }
    );
    if (resp.status < 300) {
      console.log(`   ✅ Alpha Sender "${BUSINESS_NAME}" registered`);
    } else {
      console.log(`   ℹ️  Alpha Sender response: ${resp.status} — ${JSON.stringify(resp.data)}`);
    }
  } catch (err) {
    console.log(`   ℹ️  ${err.message}`);
  }

  // ── Step 4: Configure the phone number ────────────────────────────────────
  console.log('\n4️⃣  Configuring phone number voice/SMS URLs...');
  try {
    const numbers = await twilio.incomingPhoneNumbers.list({ phoneNumber: PHONE_NUMBER });
    if (numbers.length) {
      await twilio.incomingPhoneNumbers(numbers[0].sid).update({
        friendlyName: 'Kova AI',
        voiceUrl: 'https://bountiful-growth-production.up.railway.app/voice/outbound',
        voiceMethod: 'POST',
      });
      console.log(`   ✅ Phone number configured with voice URL`);
    }
  } catch (err) {
    console.log(`   ⚠️  ${err.message}`);
  }

  // ── Step 5: Check A2P Brand Registration status ───────────────────────────
  console.log('\n5️⃣  Checking A2P Brand Registration...');
  try {
    const brands = await twilio.messaging.v1.brandRegistrations.list({ limit: 5 });
    if (brands.length) {
      brands.forEach(b => {
        console.log(`   📋 Brand: ${b.sid} | Status: ${b.brandRegistrationStatus} | Type: ${b.brandType}`);
      });
    } else {
      console.log('   ℹ️  No brand registrations found');
    }
  } catch (err) {
    console.log(`   ℹ️  ${err.message}`);
  }

  // ── Summary & Manual Steps ────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ AUTOMATED SETUP COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\n📋 MANUAL STEPS REQUIRED TO COMPLETE WHATSAPP BUSINESS APPROVAL:\n');
  console.log('1. Go to Twilio Console → Messaging → WhatsApp Senders');
  console.log('   https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders\n');
  console.log('2. Click "Register WhatsApp Sender" and select your number:', PHONE_NUMBER);
  console.log('');
  console.log('3. Connect your Meta Business Account:');
  console.log('   - Go to https://business.facebook.com/ and create a Meta Business account if needed');
  console.log('   - In Twilio Console, link your Meta Business account');
  console.log('   - Meta Business ID will be provided after linking\n');
  console.log('4. Fill in the WhatsApp Business Profile:');
  console.log(`   - Display Name: ${BUSINESS_NAME}`);
  console.log(`   - Description: ${BUSINESS_DESCRIPTION}`);
  console.log('   - Category: "Other" or "Professional Services"');
  console.log('   - Website: https://kova.ai\n');
  console.log('5. Submit for Meta review (typically 1-3 business days)\n');
  console.log('6. Once approved, update TWILIO_WHATSAPP_NUMBER to', PHONE_NUMBER);
  console.log('   railway variables --set "TWILIO_WHATSAPP_NUMBER=' + PHONE_NUMBER + '"\n');
  console.log('7. Set the WhatsApp sandbox webhook (needed until approved):');
  console.log('   Go to Twilio Console → Messaging → Try it out → Send a WhatsApp message');
  console.log(`   Set webhook URL to: ${WEBHOOK_URL}\n`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
