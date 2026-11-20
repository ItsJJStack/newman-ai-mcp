/**
 * @fileoverview Redacts secrets and sensitive data (redact.ts).
 * Hides auth, sensitive headers, and keys containing password, secret, token, or apikey
 * before sending data to the model.
 */

export function redactSecrets(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(redactSecrets);
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitiveKey =
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('apikey') ||
      lowerKey.includes('auth');

    if (isSensitiveKey) {
      if (typeof value === 'object' && value !== null) {
        result[key] = redactSecrets(value);
      } else {
        result[key] = '<redacted>';
      }
    } else if (key === 'header' && Array.isArray(value)) {
      result[key] = value.map((h: any) => {
        if (h && typeof h.key === 'string') {
          const lk = h.key.toLowerCase();
          if (lk.includes('authorization') || lk.includes('cookie') || lk.includes('api-key') || lk.includes('x-api-key')) {
            return { ...h, value: '<redacted>' };
          }
        }
        return redactSecrets(h);
      });
    } else {
      result[key] = redactSecrets(value);
    }
  }

  return result;
}
