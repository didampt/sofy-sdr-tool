import { requireEnv } from './_lib.js';

// Vercel calls the registry server-side; the bearer token never reaches the browser.
export async function fetchEntreprises(path, params = {}) {
  const base = String(process.env.SOFY_ENTREPRISES_API_URL || 'https://entreprises.system.sofy.fr').trim().replace(/\/+$/, '');
  const token = requireEnv('SOFY_ENTREPRISES_API_KEY');
  const url = new URL(`${base}${path}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SOFY_ENTREPRISES_API_URL must be an HTTP(S) base URL');
  }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
    redirect: 'error'
  });
  const data = await response.json();
  return { response, data };
}
