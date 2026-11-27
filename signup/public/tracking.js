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

// Acceptance includes saved manual-review requests.
export function isAcceptedSignup(status, data) {
  return data?.ok === true && (status === 201 || (status === 202 && data.manual_review === true));
}

function pushConversionOnce(win, key, event) {
  if (!win.__sofySignupConversions) win.__sofySignupConversions = new Set();
  if (win.__sofySignupConversions.has(key)) return false;
  try { if (win.sessionStorage.getItem(key)) return false; } catch {}
  try {
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push(event);
  } catch { return false; }
  win.__sofySignupConversions.add(key);
  try { win.sessionStorage.setItem(key, '1'); } catch {}
  return true;
}

export function trackConfirmedSignup(win, { status, data, preview = false, reference }) {
  if (preview || !isAcceptedSignup(status, data) || !reference) return false;
  return pushConversionOnce(win, `sofy_signup_conversion:${reference}`, {
    event: 'sign_up', method: 'self_service', transaction_id: reference
  });
}

// Call the returned function after the form backend confirms acceptance.
export function initFormLpTracking(win, { preview = false } = {}) {
  if (preview) return () => false;

  let advertisingAllowed = false;
  let pending = null;

  function flush() {
    if (!advertisingAllowed || !pending) return false;
    const { reference, mail, tel } = pending;
    pending = null;
    return pushConversionOnce(win, `sofy_form_LP:${reference}`, { event: 'form_LP', mail, tel });
  }

  try {
    win._hsp = win._hsp || [];
    win._hsp.push(['addPrivacyConsentListener', consent => {
      advertisingAllowed = consent?.categories
        ? consent.categories.advertisement === true
        : consent?.allowed === true;
      queueMicrotask(flush);
    }]);
  } catch { return () => false; }

  return ({ reference, mail, tel }) => {
    const email = String(mail || '').trim().toLowerCase();
    if (!reference || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\+[1-9]\d{1,14}$/.test(tel || '')) return false;
    pending = { reference, mail: email, tel };
    return flush();
  };
}
