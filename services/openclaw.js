/**
 * Build a structured memory document from the customer's profile.
 * Used by services/assistant.js to inject profile into Claude's system prompt.
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

module.exports = { buildMemoryDocument };
