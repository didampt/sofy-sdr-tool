// /api/radar.js — 📰 Contexte business d'un lead : signaux presse + web → accroche d'appel (BASHO).
// Demande de Franck (17/08) : quand une entreprise visite sofy.fr, il perd « plusieurs heures par
// semaine » à chercher pourquoi. Claude fait la recherche et livre 2 accroches prêtes à dire.
//
// PÉRIMÈTRE : hot leads issus d'une VISITE du site (Snitcher/RB2B), pas les likers LinkedIn.
// GET  ?cle=<domaine|nom>            → lit le radar en cache (gratuit)
// POST { nom, enseigne, site, ... }  → lance le radar (cache 30 j, ?forcer=1 pour re-chercher)
//
// ⚠️ RÈGLE ANTI-HALLUCINATION : un signal sans URL source ET sans date est REJETÉ côté serveur.
// Une accroche fausse prononcée devant un directeur marketing coûte plus cher que pas d'accroche.
// Ce qui est réellement consultable : presse en ligne, communiqués, site du client, offres
// d'emploi, pages LinkedIn publiques. Facebook et Instagram ne sont PAS lisibles (contenu
// derrière login, non indexé) : on rapporte les liens trouvés pour que le SDR juge en un clic.

import { verifierToken, sql, ensureSchema, loggerConso } from './db.js';

// 300 s : sur une grosse enseigne (Veepee, 1 091 avis) la recherche dépassait les 60 s et Vercel
// renvoyait une page d'erreur HTML — que le front lisait comme du JSON (« Unexpected token 'A' »).
export const config = { maxDuration: 300 };

// Garde-fous (demande Didier 17/08) : ne jamais relancer en boucle une recherche qui n'aboutit pas.
const ECHECS_MAX = 2;        // au-delà, on met l'entreprise en quarantaine
const QUARANTAINE_H = 6;     // durée de la quarantaine
const VERROU_MIN = 4;        // une seule recherche simultanée par entreprise

// Qualité de l'accroche = cœur de la valeur → Opus par défaut. Bascule sans redéploiement :
// MODELE_RADAR=claude-sonnet-5 dans Vercel divise le coût par ~2,5.
const MODELE = () => process.env.MODELE_RADAR || 'claude-opus-5';

// Annuaires et fermes de contenu : ils monopolisent la première page sur un nom de société et
// ne portent aucun signal business. On les écarte plutôt que de restreindre à une liste blanche
// de médias (qui raterait la presse spécialisée du secteur du prospect et la presse des DOM).
const DOMAINES_BLOQUES = [
  'pagesjaunes.fr', 'verif.com', 'bilansgratuits.fr', 'societe.com', 'infogreffe.fr',
  'annuaire-entreprises.data.gouv.fr', 'kompass.com', 'europages.fr', 'manageo.fr',
  'bloomberg.com', 'dnb.com', 'leadar.com', 'trouve-moi-un-numero.fr'
];

let radarPret = false;
async function ensureRadar() {
  if (radarPret || !sql) return;
  // Table PARESSEUSE (pas de bump SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS radar_cache (
    cle TEXT PRIMARY KEY,
    entreprise TEXT,
    resultat JSONB NOT NULL,
    signaux_n INTEGER DEFAULT 0,
    modele TEXT,
    maj_le TIMESTAMPTZ DEFAULT NOW()
  )`;
  // Colonnes du garde-fou, ajoutées paresseusement (jamais de bump SCHEMA_VERSION)
  await sql`ALTER TABLE radar_cache ADD COLUMN IF NOT EXISTS echecs INTEGER DEFAULT 0`;
  await sql`ALTER TABLE radar_cache ADD COLUMN IF NOT EXISTS dernier_echec TIMESTAMPTZ`;
  await sql`ALTER TABLE radar_cache ADD COLUMN IF NOT EXISTS motif_echec TEXT`;
  await sql`ALTER TABLE radar_cache ADD COLUMN IF NOT EXISTS en_cours_depuis TIMESTAMPTZ`;
  radarPret = true;
}

// Trace l'échec et met l'entreprise en quarantaine au-delà de ECHECS_MAX tentatives
async function noterEchec(cle, nom, motif) {
  try {
    await sql`INSERT INTO radar_cache (cle, entreprise, resultat, echecs, dernier_echec, motif_echec, en_cours_depuis)
      VALUES (${cle}, ${nom || ''}, '{}'::jsonb, 1, NOW(), ${String(motif || '').slice(0, 200)}, NULL)
      ON CONFLICT (cle) DO UPDATE SET echecs = COALESCE(radar_cache.echecs, 0) + 1,
        dernier_echec = NOW(), motif_echec = EXCLUDED.motif_echec, en_cours_depuis = NULL`;
  } catch (_) {}
}

// Clé de cache : le domaine si connu (stable), sinon le nom normalisé
export function cleRadar({ site, nom, enseigne }) {
  const d = String(site || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase().trim();
  if (d && d.includes('.')) return 'dom:' + d;
  const n = String(enseigne || nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(sas|sarl|sa|eurl|sasu|societe|ste|groupe)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return n ? 'nom:' + n : null;
}

function prompt(e) {
  const auj = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(new Date());
  const pages = (e.pages || []).filter(Boolean).slice(0, 6).join(', ');
  return `Nous sommes le ${auj}. Tu prépares l'appel d'un commercial (SDR) de **Sofy**, éditeur français de logiciels pour les enseignes à points de vente :
· **Soview** — avis Google et visibilité locale (fiches Google Business, collecte et réponse aux avis)
· **SoConnect** — messagerie clients centralisée (WhatsApp, Instagram, Messenger) avec agent IA
· **SoReach** — campagnes SMS et RCS

ENTREPRISE À ÉTUDIER
Nom : ${e.nom || ''}${e.enseigne && e.enseigne !== e.nom ? ` (enseigne : ${e.enseigne})` : ''}
${e.site ? `Site : ${e.site}\n` : ''}${e.ville || e.cp ? `Lieu : ${[e.ville, e.cp].filter(Boolean).join(' ')}\n` : ''}${e.secteur ? `Secteur : ${e.secteur}\n` : ''}${e.effectif ? `Effectif : ${e.effectif}\n` : ''}${pages ? `Pages qu'elle vient de consulter sur sofy.fr : ${pages}\n` : ''}
Elle vient de visiter notre site. Le SDR doit comprendre POURQUOI, et ouvrir l'appel sur un fait récent et vérifiable la concernant.

CE QUE TU CHERCHES (12 derniers mois en priorité, 18 maximum)
1. 🔧 Refonte digitale, nouveau CRM, nouvelle plateforme marketing, nouveau site e-commerce — le meilleur signal : ils investissent déjà dans la relation client, et le canal mobile est souvent absent du dispositif.
2. ⚔️ Un outil concurrent nommé publiquement (Brevo, Partoo, Digitaleo, Guest Suite, Solocal, Skeepers, Custplace, Uberall, Alcméon, SMSPartner, Esendex, Octopush, Sinch…) — on sait alors à qui on parle.
3. 🏪 Ouvertures ou fermetures de points de vente, expansion, nouvelle franchise, rachat d'un réseau.
4. 👤 Arrivée d'un nouveau dirigeant marketing, digital, e-commerce, relation ou expérience client.
5. 💰 Levée de fonds, rachat, résultats en hausse, plan d'investissement.
6. ⭐ Sujet avis clients, e-réputation, satisfaction client, note Google évoqué publiquement.
7. 💼 Offres d'emploi ouvertes en CRM, CX, e-commerce, community management, marketing digital.
8. 📣 Campagne en cours, anniversaire d'enseigne, temps fort commercial, salon.
9. 📉 Difficultés, litige, plan social, fermeture — À SIGNALER POUR ÊTRE ÉVITÉ, jamais transformé en accroche.

OÙ CHERCHER
· presse économique et professionnelle française (LSA, e-marketing, Ecommerce Mag, Journal du Net, Stratégies, Les Échos, presse régionale et presse des DOM : France-Antilles, Clicanoo, Le Journal de l'Île…)
· communiqués de presse, page « actualités » ou « presse » de leur propre site
· offres d'emploi publiées (leur site carrières, LinkedIn, Indeed, Welcome to the Jungle)
· publications publiques de leur page LinkedIn d'entreprise
· Facebook et Instagram ne sont pas consultables (contenu derrière authentification) : ne prétends jamais avoir lu leurs publications. Reporte simplement l'URL de leurs comptes si tu la trouves, dans « reseaux ».

RÈGLES ABSOLUES
· Chaque signal doit citer une **URL source réelle** que tu as consultée et une **date** (même approximative : "03/2026"). Sans les deux, ne le mentionne pas : il sera rejeté automatiquement.
· N'invente jamais un fait, un chiffre, un nom de dirigeant ou un outil. Si tu ne trouves rien de solide, renvoie une liste de signaux vide — c'est une réponse acceptable et utile.
· Vérifie que la source parle bien de CETTE entreprise (homonymes fréquents : même nom, autre région, autre activité). En cas de doute, écarte.
· Les accroches sont dites AU TÉLÉPHONE : une phrase courte, orale, qui cite le fait puis pose une question ouverte menant vers Soview, SoConnect ou SoReach. Pas de jargon, pas de flatterie.

Réponds UNIQUEMENT par cet objet JSON, sans texte autour, sans backticks :
{
 "signaux": [{"emoji":"🔧","type":"refonte_digitale|concurrent|reseau|dirigeant|financement|ereputation|recrutement|campagne|risque","titre":"le fait en une phrase factuelle","pourquoi":"ce que le SDR en fait, une phrase","date":"MM/AAAA ou JJ/MM/AAAA","source_url":"https://...","media":"nom du média ou du site","module":"soview|soconnect|soreach|null"}],
 "accroches": [{"texte":"la phrase à dire au téléphone","appui":"titre du signal sur lequel elle s'appuie"}],
 "questions": ["question de découverte qui enchaîne", "..."],
 "a_eviter": ["sujet sensible à ne pas aborder, avec sa raison"],
 "reseaux": {"linkedin":"url ou null","facebook":"url ou null","instagram":"url ou null"},
 "sources_consultees": ["url1","url2"],
 "non_accessibles": ["ce que tu n'as pas pu consulter et pourquoi"],
 "confiance": "haute|moyenne|basse",
 "resume": "deux phrases sur le contexte business actuel de l'entreprise"
}

Au maximum 5 signaux, les plus exploitables d'abord. Au maximum 2 accroches.`;
}

const estUrl = u => /^https?:\/\/[^\s]+\.[^\s]+/i.test(String(u || ''));

export async function radarEntreprise(e, user, opts = {}) {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { erreur: 'CLAUDE_API_KEY manquante' };
  const cle = cleRadar(e);
  if (!cle) return { erreur: 'Entreprise non identifiable (ni site ni nom)' };
  await ensureRadar();

  // ── État en base : cache valide, quarantaine après échecs, verrou anti-doublon ──
  let etat = null;
  try {
    const [c] = await sql`SELECT resultat, maj_le, echecs, dernier_echec, motif_echec, en_cours_depuis,
      (resultat ? 'signaux') AS a_resultat FROM radar_cache WHERE cle = ${cle}`;
    etat = c || null;
  } catch (_) {}

  // Cache 30 jours : une entreprise qui revisite dix fois ne coûte qu'une fois
  if (!opts.forcer && etat && etat.a_resultat && new Date(etat.maj_le).getTime() > Date.now() - 30 * 86400000) {
    return { ok: true, radar: etat.resultat, cache: true, maj_le: etat.maj_le };
  }

  if (etat) {
    // Verrou : une recherche déjà en cours sur cette entreprise (autre SDR, ou le cron)
    if (etat.en_cours_depuis && Date.now() - new Date(etat.en_cours_depuis).getTime() < VERROU_MIN * 60000) {
      return { erreur: 'Une recherche est déjà en cours sur cette entreprise — réessaie dans 2 minutes.', en_cours: true };
    }
    // Quarantaine : on ne relance pas indéfiniment une recherche qui échoue (demande Didier)
    const n = etat.echecs || 0;
    if (n >= ECHECS_MAX && etat.dernier_echec &&
        Date.now() - new Date(etat.dernier_echec).getTime() < QUARANTAINE_H * 3600000) {
      const restant = Math.ceil((QUARANTAINE_H * 3600000 - (Date.now() - new Date(etat.dernier_echec).getTime())) / 3600000);
      return {
        erreur: `${n} tentatives ont échoué sur cette entreprise (${etat.motif_echec || 'cause inconnue'}). Nouvelle tentative possible dans ~${restant} h.`,
        quarantaine: true, echecs: n
      };
    }
  }
  // Pose le verrou avant de dépenser
  try {
    await sql`INSERT INTO radar_cache (cle, entreprise, resultat, en_cours_depuis)
      VALUES (${cle}, ${e.enseigne || e.nom || ''}, '{}'::jsonb, NOW())
      ON CONFLICT (cle) DO UPDATE SET en_cours_depuis = NOW()`;
  } catch (_) {}

  const corps = (outils) => ({
    model: MODELE(),
    max_tokens: 5000, // la réflexion est comptée dedans : assez pour 5 signaux + 2 accroches
    // « medium » : la tâche est de la recherche et de l'extraction, pas du raisonnement profond.
    // À effort haut, Veepee dépassait les 60 s de la fonction. Ne PAS désactiver la réflexion :
    // sans elle le modèle peut écrire ses appels d'outils en texte au lieu de les exécuter.
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: prompt(e) }],
    tools: outils
  });
  const appeler = (outils) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(corps(outils))
  });

  // Outils 2026 : le filtrage de domaines écarte les annuaires qui monopolisent la 1re page
  const outils2026 = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 4, blocked_domains: DOMAINES_BLOQUES },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 6000 }
  ];
  const nom0 = e.enseigne || e.nom || '';
  let r, data;
  try {
    r = await appeler(outils2026);
    data = await r.json();
    if (r.status === 429) { await new Promise(x => setTimeout(x, 20000)); r = await appeler(outils2026); data = await r.json(); }
    // Repli : versions d'outils antérieures si le compte ou le modèle ne les expose pas
    if (!r.ok && /web_search_20260209|web_fetch_20260209|tool/i.test(JSON.stringify(data.error || ''))) {
      r = await appeler([{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }]);
      data = await r.json();
    }
    if (!r.ok) {
      const det = (data.error && data.error.message) || JSON.stringify(data).slice(0, 200);
      await noterEchec(cle, nom0, 'API Claude ' + r.status);
      return { erreur: 'API Claude', detail: det };
    }
  } catch (err) {
    const m = String(err.message || err).slice(0, 150);
    await noterEchec(cle, nom0, 'réseau : ' + m);
    return { erreur: 'Appel Claude interrompu', detail: m };
  }

  const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
  const d0 = brut.indexOf('{'), d1 = brut.lastIndexOf('}');
  let p = null;
  if (d0 >= 0 && d1 > d0) { try { p = JSON.parse(brut.slice(d0, d1 + 1)); } catch (_) {} }
  if (!p) { await noterEchec(cle, nom0, 'réponse IA non exploitable'); return { erreur: 'Réponse IA non exploitable' }; }

  // ── Validation : pas de source + date = pas de signal (règle non négociable) ──
  const rejetes = [];
  const signaux = (Array.isArray(p.signaux) ? p.signaux : []).filter(s => {
    if (!s || !s.titre) return false;
    if (!estUrl(s.source_url) || !String(s.date || '').trim()) { rejetes.push(String(s.titre).slice(0, 90)); return false; }
    return true;
  }).slice(0, 5);
  const titres = new Set(signaux.map(s => String(s.titre)));
  // Une accroche ne survit que si le signal qui la porte a survécu
  const accroches = (Array.isArray(p.accroches) ? p.accroches : [])
    .filter(a => a && a.texte && (!a.appui || titres.size === 0 || [...titres].some(t => t.includes(String(a.appui).slice(0, 25)) || String(a.appui).includes(t.slice(0, 25)))))
    .slice(0, 2);

  const radar = {
    signaux,
    accroches: signaux.length ? accroches : [],
    questions: (Array.isArray(p.questions) ? p.questions : []).slice(0, 3),
    a_eviter: (Array.isArray(p.a_eviter) ? p.a_eviter : []).slice(0, 3),
    reseaux: p.reseaux && typeof p.reseaux === 'object' ? p.reseaux : {},
    sources_consultees: (Array.isArray(p.sources_consultees) ? p.sources_consultees : []).filter(estUrl).slice(0, 10),
    non_accessibles: (Array.isArray(p.non_accessibles) ? p.non_accessibles : []).slice(0, 4),
    resume: String(p.resume || '').slice(0, 400),
    confiance: signaux.length ? (['haute', 'moyenne', 'basse'].includes(p.confiance) ? p.confiance : 'moyenne') : 'basse',
    signaux_rejetes: rejetes.slice(0, 5), // traçabilité : ce que le garde-fou a écarté
    modele: MODELE(),
    radar_le: new Date().toISOString()
  };

  // Succès : on écrit le résultat, on lève le verrou et on remet le compteur d'échecs à zéro
  try {
    await sql`INSERT INTO radar_cache (cle, entreprise, resultat, signaux_n, modele, maj_le, echecs, dernier_echec, motif_echec, en_cours_depuis)
      VALUES (${cle}, ${nom0}, ${JSON.stringify(radar)}::jsonb, ${signaux.length}, ${MODELE()}, NOW(), 0, NULL, NULL, NULL)
      ON CONFLICT (cle) DO UPDATE SET resultat = EXCLUDED.resultat, signaux_n = EXCLUDED.signaux_n,
        modele = EXCLUDED.modele, entreprise = EXCLUDED.entreprise, maj_le = NOW(),
        echecs = 0, dernier_echec = NULL, motif_echec = NULL, en_cours_depuis = NULL`;
  } catch (_) {}
  try { await loggerConso(user || { nom: 'système' }, 'ia_claude', 1, opts.liste_id || null); } catch (_) {}

  return { ok: true, radar, cache: false };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  await ensureRadar();

  // Lecture du cache (gratuit) — utilisé par la fiche et le cockpit
  if (req.method === 'GET') {
    const cle = cleRadar({ site: req.query.site, nom: req.query.nom, enseigne: req.query.enseigne });
    if (!cle) return res.status(400).json({ erreur: 'site ou nom requis' });
    try {
      const [c] = await sql`SELECT resultat, maj_le, echecs, dernier_echec, motif_echec, en_cours_depuis,
        (resultat ? 'signaux') AS a_resultat FROM radar_cache WHERE cle = ${cle}`;
      if (!c) return res.status(200).json({ ok: true, radar: null });
      const jours = Math.floor((Date.now() - new Date(c.maj_le).getTime()) / 86400000);
      // L'état du garde-fou part au front : il grise le bouton au lieu de laisser relancer en boucle
      const n = c.echecs || 0;
      const enQuarantaine = n >= ECHECS_MAX && c.dernier_echec &&
        Date.now() - new Date(c.dernier_echec).getTime() < QUARANTAINE_H * 3600000;
      return res.status(200).json({
        ok: true, radar: c.a_resultat ? c.resultat : null, maj_le: c.maj_le, jours, perime: jours >= 30,
        echecs: n, motif_echec: c.motif_echec || null, quarantaine: !!enQuarantaine,
        reprise_dans_h: enQuarantaine ? Math.ceil((QUARANTAINE_H * 3600000 - (Date.now() - new Date(c.dernier_echec).getTime())) / 3600000) : null,
        en_cours: !!(c.en_cours_depuis && Date.now() - new Date(c.en_cours_depuis).getTime() < VERROU_MIN * 60000)
      });
    } catch (e) { return res.status(500).json({ erreur: 'Lecture impossible', detail: String(e.message || e).slice(0, 150) }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET (cache) ou POST (recherche)' });
  const b = req.body || {};
  if (!b.nom && !b.enseigne && !b.site) return res.status(400).json({ erreur: 'nom, enseigne ou site requis' });
  const out = await radarEntreprise({
    nom: b.nom, enseigne: b.enseigne, site: b.site, ville: b.ville, cp: b.cp,
    secteur: b.secteur, effectif: b.effectif, pages: b.pages || []
  }, user, { forcer: !!b.forcer, liste_id: b.liste_id });
  // 429 = refus volontaire du garde-fou (quarantaine ou recherche déjà en cours), pas une panne
  if (out.erreur) return res.status(out.quarantaine || out.en_cours ? 429 : 502).json(out);
  return res.status(200).json(out);
}
