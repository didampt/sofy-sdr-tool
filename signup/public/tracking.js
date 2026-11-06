// Google conversion events and raw traffic context for the existing CRM note.
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

export function trafficSnapshot(location, referrer = '') {
  const params = new URLSearchParams(location.search);
  return {
    landing_page: location.href,
    referrer,
    ...Object.fromEntries([...UTM_KEYS, ...CLICK_IDS].map(key => [key, String(params.get(key) || '').trim().slice(0, 300)]))
  };
}

export function initAttribution(win, doc) {
  const storageKey = 'sofy_signup_attribution_v1';
  const current = trafficSnapshot(win.location, doc.referrer || '');
  let original;
  try { original = JSON.parse(win.localStorage.getItem(storageKey) || 'null'); } catch {}
  if (!original || typeof original !== 'object' || !original.first_seen_at) {
    original = { ...current, first_seen_at: new Date().toISOString() };
    try { win.localStorage.setItem(storageKey, JSON.stringify(original)); } catch {}
  }
  return { original, current: { ...current, seen_at: new Date().toISOString() } };
}

// One event per server-accepted signup, including saved manual-review requests. Never include form data or click IDs.
export function isAcceptedSignup(status, data) {
  return data?.ok === true && (status === 201 || (status === 202 && data.manual_review === true));
}

export function trackConfirmedSignup(win, { status, data, preview = false, reference }) {
  const accepted = isAcceptedSignup(status, data);
  if (preview || !accepted || data?.ok !== true || !reference) return false;
  const key = `sofy_signup_conversion:${reference}`;
  if (!win.__sofySignupConversions) win.__sofySignupConversions = new Set();
  if (win.__sofySignupConversions.has(key)) return false;
  try { if (win.sessionStorage.getItem(key)) return false; } catch {}
  try {
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push({ event: 'sign_up', method: 'self_service', transaction_id: reference });
  } catch { return false; }
  win.__sofySignupConversions.add(key);
  try { win.sessionStorage.setItem(key, '1'); } catch {}
  return true;
}
