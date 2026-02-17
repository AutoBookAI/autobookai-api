const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

// ── Startup guard — refuse to start with a missing or weak key ──────────────
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('FATAL: ENCRYPTION_KEY must be set and at least 32 characters.');
  process.exit(1);
}
const MASTER_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);

/**
 * Derive a per-customer encryption key using HKDF.
 * Even if one customer's data is somehow exposed alongside their derived key,
 * other customers' data remains protected.
 */
function deriveCustomerKey(customerId) {
  if (!customerId) return MASTER_KEY; // Fallback for non-customer data
  const info = Buffer.from(`customer:${customerId}`, 'utf8');
  return crypto.hkdfSync('sha256', MASTER_KEY, Buffer.alloc(0), info, 32);
}

/**
 * Encrypt a string. Optionally scope to a specific customer.
 * Returns: iv:authTag:ciphertext
 */
function encrypt(text, customerId) {
  if (!text) return null;
  const key = deriveCustomerKey(customerId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a previously encrypted string. Must use the same customerId.
 */
function decrypt(encryptedText, customerId) {
  if (!encryptedText) return null;
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const key = deriveCustomerKey(customerId);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Try master key as fallback for data encrypted before per-customer keys
    try {
      const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }
}

/**
 * Encrypt a JSON object.
 */
function encryptJSON(obj, customerId) {
  if (!obj) return null;
  return encrypt(JSON.stringify(obj), customerId);
}

/**
 * Decrypt a JSON object.
 */
function decryptJSON(encrypted, customerId) {
  const str = decrypt(encrypted, customerId);
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON };
