// /api/ai-visibilite.js — 🤖 Le prospect est-il cité par l'IA de Google ?
//
// C'est le sujet du deck Sofy (« Enjeux Visibilité & IA ») que personne ne mesure : quand un
// client demande à l'IA de Google « meilleure entreprise de nettoyage à Rennes », qui est cité ?
// Jusqu'ici on affirmait que les IA lisent les fiches et le balisage. Ici on le PROUVE, dans un
// sens ou dans l'autre — et « vous n'êtes pas cité, vos trois concurrents le sont » est l'argument
// le plus neuf que Sofy puisse poser sur la table.
//
// POST { requete, domaine?, nom?, place_id? }
//   requete = ce qu'un client demanderait (« meilleure entreprise de nettoyage à Rennes »)
//   domaine = le site du prospect, pour le repérer dans les sources citées
//
// Deux appels au plus : la recherche Google (qui porte l'aperçu IA ou un jeton), puis l'aperçu
// lui-même si Google le renvoie séparément. Environ 0,01 $ chacun.

import { verifierToken, sql } from './db.js';

export const config = { maxDuration: 60 };
const CACHE_JOURS = 21;   // les réponses de l'IA bougent plus vite qu'une fiche

let pret = false;
async function ensureIA() {
  if (pret || !sql) return;
  await sql`CREATE TABLE IF NOT EXISTS ia_visibilite (
    cle TEXT PRIMARY KEY,
    requete TEXT, domaine TEXT, nom TEXT,
    apercu_present BOOLEAN,
    cite BOOLEAN,
    rang_citation INTEGER,
    sources JSONB,
    entreprises_citees JSONB,
    extrait TEXT,
    mesure_le TIMESTAMPTZ DEFAULT NOW(),
    mesure_par TEXT
  )`;
  pret = true;
}

const domaineDe = u => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return String(u || '').toLowerCase().replace(/^www\./, ''); }
};

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureIA();

  const cle = process.env.SERPAPI_KEY;
  if (!cle) return res.status(500).json({ erreur: 'SERPAPI_KEY absente', detail: 'À créer dans Vercel, puis redéployer.' });

  const b = req.body || {};
  const requete = String(b.requete || '').trim();
  if (requete.length < 6) return res.status(400).json({ erreur: 'Donne la requête qu\'un client taperait (6 caractères minimum)' });
  const dom = b.domaine ? domaineDe(b.domaine) : null;
  const nom = b.nom ? String(b.nom).trim() : null;
  const cleCache = (requete + '|' + (dom || nom || '')).toLowerCase().slice(0, 200);

  if (!b.forcer) {
    try {
      const [c] = await sql`SELECT * FROM ia_visibilite WHERE cle = ${cleCache}
        AND mesure_le > NOW() - (${CACHE_JOURS} || ' days')::interval`;
      if (c) return res.status(200).json({ ok: true, cache: true, mesure: c });
    } catch (_) { }
  }

  const lire = async (params) => {
    const u = 'https://serpapi.com/search.json?' + new URLSearchParams({ ...params, hl: 'fr', gl: 'fr', api_key: cle }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
  };

  let apercu = null;
  try {
    const rep = await lire({ engine: 'google', q: requete });
    if (!rep.ok) return res.status(502).json({ erreur: 'SerpApi ' + rep.status, detail: String((rep.d && rep.d.error) || '').slice(0, 200) });
    apercu = rep.d.ai_overview || null;
    // Google renvoie parfois l'aperçu derrière un jeton : un second appel le déplie.
    if (apercu && apercu.page_token && !apercu.text_blocks) {
      const suite = await lire({ engine: 'google_ai_overview', page_token: apercu.page_token });
      if (suite.ok && suite.d.ai_overview) apercu = suite.d.ai_overview;
    }
  } catch (e) {
    return res.status(502).json({ erreur: 'SerpApi injoignable', detail: String((e && e.message) || e).slice(0, 160) });
  }

  if (!apercu) {
    const mesure = {
      cle: cleCache, requete, domaine: dom, nom, apercu_present: false, cite: false,
      rang_citation: null, sources: null, entreprises_citees: null, extrait: null
    };
    try {
      await sql`INSERT INTO ia_visibilite (cle, requete, domaine, nom, apercu_present, cite, mesure_le, mesure_par)
        VALUES (${cleCache}, ${requete}, ${dom}, ${nom}, FALSE, FALSE, NOW(), ${user.nom})
        ON CONFLICT (cle) DO UPDATE SET apercu_present = FALSE, cite = FALSE, mesure_le = NOW()`;
    } catch (_) { }
    return res.status(200).json({
      ok: true, mesure,
      resume: `Google n'affiche pas encore d'aperçu IA sur « ${requete} ». Ce n'est pas un point faible du prospect : la requête n'en déclenche pas.`
    });
  }

  // Les sources citées par l'aperçu : c'est là que se joue la visibilité.
  const refs = Array.isArray(apercu.references) ? apercu.references : [];
  const sources = refs.slice(0, 12).map((r, i) => ({
    rang: i + 1, titre: r.title || null, lien: r.link || null,
    domaine: r.link ? domaineDe(r.link) : null, source: r.source || null
  }));
  const trouve = sources.find(s =>
    (dom && s.domaine && (s.domaine === dom || s.domaine.endsWith('.' + dom) || dom.endsWith('.' + s.domaine)))
    || (nom && s.titre && s.titre.toLowerCase().includes(nom.toLowerCase())));

  // Le texte de l'aperçu, pour lire quelles enseignes l'IA met en avant.
  const texte = (apercu.text_blocks || []).map(bl => {
    if (bl.snippet) return bl.snippet;
    if (Array.isArray(bl.list)) return bl.list.map(x => x.snippet || x.title || '').join(' · ');
    return '';
  }).join('\n').slice(0, 1400);

  // Les enseignes citées : on part des sources, puis des titres de liste (les plus parlants).
  const citees = [];
  for (const s of sources) {
    const n = (s.source || s.titre || '').split(/[-–|]/)[0].trim();
    if (n && n.length > 2 && !citees.includes(n)) citees.push(n);
  }

  const mesure = {
    cle: cleCache, requete, domaine: dom, nom,
    apercu_present: true,
    cite: !!trouve,
    rang_citation: trouve ? trouve.rang : null,
    sources, entreprises_citees: citees.slice(0, 8), extrait: texte || null
  };

  try {
    await sql`INSERT INTO ia_visibilite (cle, requete, domaine, nom, apercu_present, cite,
        rang_citation, sources, entreprises_citees, extrait, mesure_le, mesure_par)
      VALUES (${cleCache}, ${requete}, ${dom}, ${nom}, TRUE, ${mesure.cite}, ${mesure.rang_citation},
              ${JSON.stringify(sources)}::jsonb, ${JSON.stringify(mesure.entreprises_citees)}::jsonb,
              ${mesure.extrait}, NOW(), ${user.nom})
      ON CONFLICT (cle) DO UPDATE SET apercu_present = TRUE, cite = EXCLUDED.cite,
        rang_citation = EXCLUDED.rang_citation, sources = EXCLUDED.sources,
        entreprises_citees = EXCLUDED.entreprises_citees, extrait = EXCLUDED.extrait,
        mesure_le = NOW(), mesure_par = EXCLUDED.mesure_par`;
  } catch (_) { }

  return res.status(200).json({
    ok: true, cache: false, mesure,
    resume: mesure.cite
      ? `Cité par l'aperçu IA de Google sur « ${requete} », en source n°${mesure.rang_citation}.`
      : `PAS cité par l'aperçu IA de Google sur « ${requete} »${mesure.entreprises_citees.length ? ` — l'IA renvoie vers ${mesure.entreprises_citees.slice(0, 3).join(', ')}` : ''}.`,
    cout_estime_usd: 0.02
  });
}
