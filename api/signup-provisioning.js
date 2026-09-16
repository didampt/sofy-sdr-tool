import crypto from 'crypto';

function encryptionKey() {
  const secret = String(process.env.SIGNUP_HOTLEAD_TOKEN || process.env.SOFY_SIGNUP_TOKEN || '').trim();
  if (!secret) throw new Error('SIGNUP_HOTLEAD_TOKEN or SOFY_SIGNUP_TOKEN is not configured');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSignupProvisioning(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from('sofy-signup-provisioning:v1'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload || {}), 'utf8'),
    cipher.final()
  ]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSignupProvisioning(value) {
  try {
    const [version, ivValue, tagValue, encryptedValue] = String(value || '').split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAAD(Buffer.from('sofy-signup-provisioning:v1'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    const payload = JSON.parse(plaintext);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
}
