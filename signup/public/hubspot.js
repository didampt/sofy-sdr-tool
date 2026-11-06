import { isAcceptedSignup } from './tracking.js';

// Public portal ID verified against the signup CRM API key and www.sofy.fr.
export const HUBSPOT_PORTAL_ID = '147834354';
export const HUBSPOT_CONFIRMATION_PATH = '/signup/confirmed';

export function initHubSpotAttribution(win, doc, { preview = false } = {}) {
  // Keep local development, Vercel previews and UI previews out of live analytics.
  if (preview || win.location.hostname !== 'signup.sofy.fr') return () => false;

  let analyticsAllowed = false;
  let pending = null;
  const sent = new Set();

  function flush() {
    if (!analyticsAllowed || !pending) return false;
    const { email, reference } = pending;
    const key = `sofy_hubspot_signup:${reference}`;
    if (sent.has(key)) { pending = null; return false; }
    try {
      if (win.sessionStorage.getItem(key)) { pending = null; return false; }
    } catch {}
    try {
      // identify alone does not send the identity. The following page view links
      // HubSpot's visitor cookie/history to the contact created by our CRM sync.
      win._hsq.push(['identify', { email }]);
      win._hsq.push(['setPath', HUBSPOT_CONFIRMATION_PATH]);
      win._hsq.push(['trackPageView']);
    } catch { return false; }
    sent.add(key);
    pending = null;
    try { win.sessionStorage.setItem(key, '1'); } catch {}
    return true;
  }

  try {
    win._hsq = win._hsq || [];
    // Registered through the tracker queue; defer pending delivery until its
    // startup queue has drained so the real landing view is recorded first.
    win._hsq.push(['addPrivacyConsentListener', consent => {
      analyticsAllowed = consent?.categories && 'analytics' in consent.categories
        ? consent.categories.analytics === true
        : consent?.allowed === true;
      queueMicrotask(flush);
    }]);
    if (!doc.getElementById('hs-script-loader') && !doc.querySelector(`script[src*="hs-scripts.com/${HUBSPOT_PORTAL_ID}"]`)) {
      const script = doc.createElement('script');
      script.id = 'hs-script-loader';
      script.async = true;
      script.defer = true;
      script.src = `https://js-eu1.hs-scripts.com/${HUBSPOT_PORTAL_ID}.js`;
      doc.head.appendChild(script);
    }
  } catch { return () => false; }

  return ({ status, data, reference, email, preview: signupPreview = false }) => {
    if (signupPreview || !isAcceptedSignup(status, data) || !reference) return false;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return false;
    pending = { email: normalizedEmail, reference };
    return flush();
  };
}
