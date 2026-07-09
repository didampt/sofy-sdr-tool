// /api/email-web.js — Recherche WEB par IA du site + email d'un établissement (listes Google Maps).
// Utilise l'outil de recherche web intégré à l'API Anthropic (même clé que le reste) :
// Claude cherche réellement sur le web (site officiel, annuaires, pages contact) et renvoie
// un JSON strict. Anti-hallucination : email UNIQUEMENT s'il est vu sur une source, sinon null.
//
// POST { nom, ville, activite?, site?, liste_id? }
//   -> { ok, site, email, telephone, source }
// Coût : ~0,02-0,05 €/appel (recherches web facturées par Anthropic) -> journalisé (ia_web_email).
// 1 fiche par appel : la boucle se fait côté navigateur (pas de limite Vercel, SDR garde la main).

const ANTHRO = 'https://api.anthropic.com/v1/messages';

function emailValide(e) {
  return typeof e === 'string' && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e.trim()) && e.length < 80;
}
function domaineSimple(s) {
  if (!s || typeof s !== 'string') return null;
  try { return new URL(s.startsWith('http') ? s : 'https://' + s).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

export default async function handler(req, res) {
  const { verifierToken, loggerConso } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante' });

  const b = req.body || {};
  const nom = String(b.nom || '').trim();
  const ville = String(b.ville || '').trim();
  const activite = String(b.activite || '').trim();
  const siteConnu = String(b.site || '').trim();
  if (!nom || !ville) return res.status(400).json({ erreur: 'nom et ville requis' });

  const prompt = `Trouve le SITE WEB OFFICIEL et l'EMAIL DE CONTACT de cet établissement français :
« ${nom} »${activite ? ' — ' + activite : ''} à ${ville}.
${siteConnu ? `Site déjà connu : ${siteConnu} (cherche l'email dessus et ailleurs si besoin).` : ''}
Cherche sur le web : site officiel (pages contact / mentions légales), annuaires (PagesJaunes…), réseaux sociaux publics, plateformes de réservation.

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour :
{"site":"domaine.fr ou null","email":"adresse@... ou null","telephone":"numéro ou null","source":"où l'email a été vu (ex: page contact du site, PagesJaunes) ou null"}

Règles ABSOLUES :
- email : uniquement si tu l'as RÉELLEMENT VU sur une source pendant ta recherche. Ne devine JAMAIS un email (pas de contact@domaine construit par déduction). En cas de doute : null.
- Vérifie que l'établissement correspond bien (même nom, même ville).
- Préfère l'email de contact générique de l'établissement à un email personnel.`;

  try {
    const r = await fetch(ANTHRO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        temperature: 0,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const surcharge = (r.status === 529 || r.status === 429);
      return res.status(surcharge ? 503 : 502).json({ erreur: surcharge ? 'Service IA saturé, réessaie dans quelques secondes' : 'Erreur IA', detail: JSON.stringify(data.error || {}).slice(0, 200) });
    }
    // Concatène les blocs texte puis prend le DERNIER objet JSON (la réponse finale après les recherches)
    const txt = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    const matches = txt.match(/\{[^{}]*\}/g) || [];
    let parsed = null;
    for (let i = matches.length - 1; i >= 0; i--) {
      try { const p = JSON.parse(matches[i]); if ('email' in p || 'site' in p) { parsed = p; break; } } catch (e) {}
    }
    if (!parsed) return res.status(200).json({ ok: false, erreur: 'Réponse IA non exploitable', brut: txt.slice(0, 200) });

    const email = emailValide(parsed.email) ? parsed.email.trim().toLowerCase() : null;
    const site = domaineSimple(parsed.site);
    const telephone = (typeof parsed.telephone === 'string' && parsed.telephone.replace(/\D/g, '').length >= 9) ? parsed.telephone.trim() : null;
    const source = (typeof parsed.source === 'string' && parsed.source !== 'null') ? parsed.source.slice(0, 120) : null;

    try { await loggerConso(user, 'ia_web_email', 1, b.liste_id || null); } catch (e) {}
    return res.status(200).json({ ok: true, site, email, telephone, source });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur recherche web IA', detail: String(e.message || e).slice(0, 200) });
  }
}
