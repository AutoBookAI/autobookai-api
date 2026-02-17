const axios = require('axios');

/**
 * Send customer profile data to their OpenClaw instance so it can use
 * it as persistent memory / context for all conversations.
 *
 * OpenClaw stores this in its local memory system so Claude always
 * knows the customer's preferences, loyalty numbers, etc.
 */
async function syncProfileToOpenClaw(serviceUrl, setupPassword, profile) {
  if (!serviceUrl) throw new Error('No service URL for this customer');

  // Build a structured memory document OpenClaw will store
  const memoryContent = buildMemoryDocument(profile);

  try {
    // OpenClaw has a REST API for injecting memories/context
    await axios.post(
      `${serviceUrl}/api/memory`,
      {
        key: 'customer_profile',
        content: memoryContent,
        persistent: true,
      },
      {
        headers: {
          'Authorization': `Bearer ${setupPassword}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`✅ Profile synced to OpenClaw at ${serviceUrl}`);
  } catch (err) {
    console.error('Failed to sync profile to OpenClaw:', err.message);
    // Non-fatal — OpenClaw will still work, just without pre-loaded profile
  }
}

/**
 * Send a message directly to a customer's OpenClaw instance
 * (used for onboarding messages, admin notifications, etc.)
 */
async function sendMessageToOpenClaw(serviceUrl, setupPassword, message) {
  try {
    const response = await axios.post(
      `${serviceUrl}/api/message`,
      { content: message },
      {
        headers: {
          'Authorization': `Bearer ${setupPassword}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    return response.data;
  } catch (err) {
    console.error('Failed to send message to OpenClaw:', err.message);
    throw err;
  }
}

/**
 * Check if a customer's OpenClaw instance is healthy
 */
async function checkOpenClawHealth(serviceUrl) {
  try {
    const response = await axios.get(`${serviceUrl}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Build a structured memory document from the customer's profile
 * This is what OpenClaw/Claude will use to personalise all responses
 */
function buildMemoryDocument(profile) {
  const sections = [];

  if (profile.full_name) {
    sections.push(`CUSTOMER NAME: ${profile.full_name}`);
  }

  if (profile.dietary_restrictions) {
    sections.push(`DIETARY RESTRICTIONS: ${profile.dietary_restrictions}`);
  }

  if (profile.cuisine_preferences) {
    sections.push(`CUISINE PREFERENCES: ${profile.cuisine_preferences}`);
  }

  if (profile.preferred_restaurants) {
    sections.push(`FAVOURITE RESTAURANTS: ${profile.preferred_restaurants}`);
  }

  if (profile.dining_budget) {
    sections.push(`DINING BUDGET: ${profile.dining_budget}`);
  }

  if (profile.preferred_airlines) {
    sections.push(`PREFERRED AIRLINES: ${profile.preferred_airlines}`);
  }

  if (profile.seat_preference) {
    sections.push(`SEAT PREFERENCE: ${profile.seat_preference}`);
  }

  if (profile.cabin_class) {
    sections.push(`PREFERRED CABIN CLASS: ${profile.cabin_class}`);
  }

  if (profile.hotel_preferences) {
    sections.push(`HOTEL PREFERENCES: ${profile.hotel_preferences}`);
  }

  if (profile.loyalty_numbers) {
    let loyaltyText;
    if (Array.isArray(profile.loyalty_numbers)) {
      loyaltyText = profile.loyalty_numbers
        .filter(l => l.program || l.number)
        .map(l => `- ${l.program}: ${l.number}`)
        .join('\n');
    } else {
      loyaltyText = String(profile.loyalty_numbers);
    }
    if (loyaltyText) {
      sections.push(`LOYALTY PROGRAMS:\n${loyaltyText}`);
    }
  }

  if (profile.preferred_contact) {
    sections.push(`PREFERRED CONTACT METHOD: ${profile.preferred_contact}`);
  }

  return `=== PERSONAL AI ASSISTANT PROFILE ===\n\n${sections.join('\n\n')}\n\n=== END PROFILE ===\n\nAlways use this profile to personalise responses and make bookings. Never share this information with third parties.`;
}

module.exports = { syncProfileToOpenClaw, sendMessageToOpenClaw, checkOpenClawHealth };
