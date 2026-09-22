// /api/personas.js — Wave 2 : trouver les PERSONNES aux postes ciblés (Dir Commercial, Dir Réseau…)
// POST {entreprise:{nom, enseigne, site, ville, linkedin, siren}, jobs:["Dir Marketing", …]}
//   → {personas:[{prenom, nom, fonction, linkedin, confiance, cible}], salaries:[…]}
//
// Waterfall (v244, voie SIREN ajoutée 09/2026 « solution Etienne ») :
//   1. Basile /people/find par SIREN (exact : dirigeants registre + salariés LinkedIn) puis par
//      EMPLOYEUR en complément — données réelles (~0,01 €, zéro hallucination). Filtre postes côté
//      serveur car le champ current_job_functions de Basile est peu fiable (testé : "Marketing" → 0).
//      `salaries` = TOUS les salariés valides (≤30) pour le choix manuel « façon Sales Nav » ;
//      `personas` = auto-ajout ≤5 (pipeline inchangé).
//   2. Repli : agent Claude + recherche web uniquement si Basile ne classe aucun décideur.
// Les contacts trouvés passent ensuite dans le waterfall standard (Dropcontact → FullEnrich).

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

export const config = { maxDuration: 120 };

// ───────────────────────── Étape 1 : Basile ─────────────────────────

function normaliser(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Racine du domaine ("www.meilleurutilitaire.com" → "meilleurutilitaire")
function racineDomaine(site) {
  const d = String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const r = d.split('.')[0];
  return r.length >= 5 ? r : '';
}

// Valeurs du filtre employer : exact ("X" = legal_name + current_company_name) + contains
// (noms LinkedIn décorés : "X.com", "Groupe X"). include = OR chez Basile.
function valeursEmployeur(entreprise) {
  const vus = new Set(); const vals = [];
  const cands = [entreprise.enseigne, entreprise.nom, racineDomaine(entreprise.site)];
  for (const c of cands) {
    const v = String(c || '').trim();
    if (v.length < 3 || vus.has(v.toLowerCase())) continue;
    vus.add(v.toLowerCase());
    vals.push('"' + v + '"');
    if (v.length >= 5) vals.push(v); // contains uniquement si assez spécifique (évite "GBH" → tout et n'importe quoi)
  }
  return vals;
}

// Anti-faux-positifs du contains : le nom d'entreprise du lead doit vraiment correspondre à la fiche.
function memeEntreprise(nomLead, refs) {
  const n = normaliser(nomLead).replace(/\b(sas|sasu|sarl|sa|eurl|sci|holding|groupe|group|france|com|fr|net)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/ /g, '');
  if (!n) return false;
  for (const ref of refs) {
    if (!ref) continue;
    if (n === ref) return true;
    if (ref.length >= 5 && (n.includes(ref) || ref.includes(n))) return true;
  }
  return false;
}

// Mots-clés significatifs des postes ciblés ("Directeur Marketing" → "marketing").
const MOTS_GENERIQUES = new Set(['directeur', 'directrice', 'dir', 'direction', 'responsable', 'resp',
  'head', 'chef', 'manager', 'adjoint', 'adjointe', 'de', 'du', 'des', 'le', 'la', 'les', 'et', 'd', 'l', 'of', 'the',
  // « N'importe quel décideur » (chip du 22/09) et variantes libres : 100 % générique →
  // generique=true → tout décideur (REPLI_DECIDEUR) devient cible, au lieu de filtrer par fonction.
  'importe', 'quel', 'quelle', 'decideur', 'decideuse', 'indifferent', 'indifferente', 'tout', 'tous', 'poste', 'peu']);
function motsClesJobs(jobs) {
  const mots = new Set(); let generique = false;
  for (const j of jobs) {
    const toks = normaliser(j).split(' ').filter(t => t.length >= 2 && !MOTS_GENERIQUES.has(t));
    if (toks.length) toks.forEach(t => mots.add(t)); else generique = true; // job 100% générique ("Directeur")
  }
  return { mots: [...mots], generique };
}

const EXCLUS_FONCTION = /commissaire|liquidateur|administrateur judiciaire|stagiaire|alternant|apprenti|assistant|technico/i;
const REPLI_DECIDEUR = /fondat|founder|\bceo\b|\bcoo\b|\bdg\b|\bpdg\b|president|directeur|directrice|gerant/;

async function leadsBasile(filters, cle) {
  const r = await fetch('https://api.basile.cc/people/find', {
    method: 'POST',
    headers: { 'Authorization': cle, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100, filters })
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.success === false) return null;
  return d.leads || [];
}

// Recherche Basile en deux voies :
//   1. SIREN (fiches Pappers/Verticale) — exact : dirigeants du registre ET salariés LinkedIn
//      (le filtre siren résout la page LinkedIn de l'entreprise — évolution API constatée 09/2026 ;
//      avant, siren ne renvoyait que les mandataires légaux). Pas de garde memeEntreprise : exact.
//   2. Nom d'employeur (voie historique) — en complément si le SIREN manque ou rapporte peu
//      (page LinkedIn non liée au SIREN chez Basile → meta.noticeCode siren_no_linkedin_company).
// Sort AUSSI la liste complète des salariés valides (`salaries`, plafond 30) pour que le SDR/AE
// puisse choisir lui-même « façon Sales Nav » — l'auto-ajout reste limité à 5 (pipeline inchangé).
async function personasBasile(entreprise, jobs, cle, jobsExclus) {
  const siren = String(entreprise.siren || '').replace(/\D/g, '');
  const refs = [entreprise.enseigne, entreprise.nom, racineDomaine(entreprise.site)]
    .map(x => normaliser(x || '').replace(/ /g, '')).filter(x => x.length >= 4);
  const { mots, generique } = motsClesJobs(jobs);

  const cibles = [], replis = [], autres = [], vus = new Set();
  // Classe un paquet de leads ; renvoie le nb RETENUS (après gardes d'appartenance/fonction).
  // Voie SIREN (exact) : on vérifie quand même l'appartenance (siren du lead OU nom d'entreprise) —
  // Basile ignore SILENCIEUSEMENT les filtres qu'il ne connaît pas (leçon du 21/07) : si le filtre
  // siren était ignoré, on recevrait 100 profils quelconques qu'il faut tous écarter.
  function classer(leads, exact) {
    let retenus = 0;
    for (const lead of (leads || [])) {
      const x = lead.data || lead || {};
      const prenom = x.people_first_name || x.result_first_name || '';
      const nomC = x.people_last_name || x.result_last_name || '';
      if (!nomC && !prenom) continue;
      const kNom = normaliser(prenom + ' ' + nomC);
      if (vus.has(kNom)) continue;
      const memeEnt = memeEntreprise(x.current_company_name || x.legal_name || '', refs);
      const okEntreprise = exact
        ? (String(x.siren || '').replace(/\D/g, '') === siren || memeEnt)
        : memeEnt;
      if (!okEntreprise) continue;

      const fonction = x.result_role || x.current_job_title || '';
      if (EXCLUS_FONCTION.test(fonction)) continue;
      const fn = normaliser(fonction);
      // Fonctions EXCLUES par le SDR (champ Basile ✕ Exclure) : écartées d'office
      if ((jobsExclus || []).some(e => fn.includes(normaliser(e)))) continue;

      const p = {
        prenom, nom: nomC, fonction: fonction || 'Contact',
        linkedin: x.profile_url || null, confiance: 'haute'
      };
      vus.add(kNom); retenus++;
      if (mots.some(m => fn.includes(m)) || (generique && REPLI_DECIDEUR.test(fn))) {
        p.cible = true; cibles.push(p);
      } else if (REPLI_DECIDEUR.test(fn)) {
        p.cible = false; replis.push(p);
      } else {
        // Salarié valide hors décideurs : jamais auto-ajouté, mais proposé au choix manuel.
        p.cible = null; autres.push(p);
      }
    }
    return retenus;
  }

  let retenusSiren = 0;
  if (siren.length === 9) {
    const l = await leadsBasile({ siren: { include: [siren] }, hide_legal_entities: true }, cle);
    retenusSiren = classer(l, true);
  }
  // Voie employeur : si pas de SIREN, ou si le SIREN a RETENU peu (< 3) — y compris le cas où le
  // filtre siren serait ignoré par l'API (100 leads bruts, 0 retenu après garde).
  if (retenusSiren < 3) {
    const valeurs = valeursEmployeur(entreprise);
    if (valeurs.length) {
      const l = await leadsBasile({ employer: { include: valeurs }, hide_legal_entities: true }, cle);
      classer(l, false);
    }
  }

  const personas = cibles.concat(replis.slice(0, 2)).slice(0, 5);
  const salaries = cibles.concat(replis, autres).slice(0, 30);
  if (!personas.length && !salaries.length) return null;
  const voie = retenusSiren > 0 ? 'SIREN' : 'nom d’employeur';
  return {
    personas,
    salaries,
    linkedin_entreprise: null,
    explication: personas.length
      ? `${personas.length} contact(s) trouvés via Basile par ${voie} (salariés LinkedIn + registre légal)${replis.length && cibles.length ? ', décideurs de repli inclus' : ''}${salaries.length > personas.length ? ` — ${salaries.length} salariés au total` : ''}`
      : `Aucun décideur aux postes ciblés, mais ${salaries.length} salarié(s) LinkedIn trouvés via Basile par ${voie} (choix manuel possible)`
  };
}

// ───────────────────────── Handler ─────────────────────────

export default async function handler(req, res) {

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { entreprise = {} } = req.body || {};
  // « ~mot » (mode CONTIENT de la Recherche avancée / des modales) : le ~ est un marqueur front,
  // motsClesJobs tokenise déjà en mots-clés — on strip pour la voie Basile ET le prompt IA.
  const jobs = (Array.isArray(req.body.jobs) ? req.body.jobs : [])
    .map(x => String(x || '').trim().replace(/^~\s*/, '')).filter(Boolean);
  const jobsExclus = (Array.isArray(req.body.jobs_exclus) ? req.body.jobs_exclus : [])
    .map(x => String(x || '').trim().replace(/^~\s*/, '')).filter(Boolean).slice(0, 20);
  if (!entreprise.nom || !jobs.length) return res.status(400).json({ erreur: 'entreprise.nom et jobs requis' });

  try {
    // ── Étape 1 : Basile (pas cher, données réelles) ──
    let salariesBasile = null; // salariés trouvés sans décideur classé : joints au repli Claude
    if (process.env.BASILE_API_KEY) {
      let viaBasile = null;
      try { viaBasile = await personasBasile(entreprise, jobs, process.env.BASILE_API_KEY, jobsExclus); } catch (_) { viaBasile = null; }
      if (viaBasile) {
        await loggerConso(user, 'basile', 1, (req.body && req.body.liste_id) || req.query.liste_id);
        if ((viaBasile.personas || []).length) {
          return res.status(200).json({ ok: true, resultat: viaBasile });
        }
        // Des salariés mais aucun décideur aux postes ciblés : on tente quand même le repli
        // Claude (il peut trouver un décideur hors LinkedIn/Basile) SANS perdre la liste.
        salariesBasile = viaBasile.salaries || null;
      }
    }

    // ── Étape 2 : repli — agent Claude + recherche web (ancien comportement) ──
    const prompt = `Tu es un assistant de prospection B2B. Trouve les PERSONNES occupant actuellement ces postes dans cette entreprise française :

Entreprise : ${entreprise.nom}${entreprise.enseigne ? ` (enseigne : ${entreprise.enseigne})` : ''}
${entreprise.site ? `Site web : ${entreprise.site}` : ''}
${entreprise.linkedin ? `Page LinkedIn de l'entreprise (déjà connue, utilise-la directement) : ${entreprise.linkedin}` : ''}
Ville : ${entreprise.ville || ''}
Postes recherchés en priorité : ${jobs.join(', ')}${jobsExclus.length ? `\nPostes à EXCLURE absolument : ${jobsExclus.join(', ')}` : ''}
Postes acceptés en repli (décideurs locaux, à proposer même s'ils ne correspondent pas exactement) : Directeur, Directeur Adjoint, Directeur d'exploitation, Responsable (marketing/commercial/communication/établissement), Gérant, DG, CEO, COO, Fondateur

Méthode :
1. ${entreprise.linkedin ? `La page LinkedIn de l'entreprise est ${entreprise.linkedin} — va directement sur sa page "people" : ${entreprise.linkedin.replace(/\/$/,'')}/people` : `Cherche la page LinkedIn de l'entreprise ("${entreprise.enseigne || entreprise.nom} linkedin"${entreprise.site ? `, "site:linkedin.com ${entreprise.site}"` : ''})`}
2. Cherche les profils publics : "site:linkedin.com/in ${entreprise.enseigne || entreprise.nom} ${jobs[0]}" et variantes pour chaque poste prioritaire, puis pour les postes de repli (directeur, responsable, gérant…)
2bis. Consulte aussi la page "people" de l'entreprise si trouvée : "linkedin.com/company/…/people"
3. Vérifie que la personne travaille ACTUELLEMENT dans cette entreprise (pas un ancien poste)

RÈGLES STRICTES :
- Maximum 5 personnes, classées : postes prioritaires d'abord, puis décideurs de repli — uniquement des trouvailles RÉELLES vérifiées dans tes résultats de recherche, n'invente JAMAIS un nom
- Une petite entreprise n'a souvent PERSONNE à ces postes : c'est une réponse normale et utile (liste vide)
- Ne confonds pas avec une entreprise homonyme ou une société sœur d'une autre île

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"personas": [{"prenom": "…", "nom": "…", "fonction": "…", "linkedin": "linkedin.com/in/… ou null", "confiance": "haute|moyenne|basse", "cible": true|false}], "linkedin_entreprise": "linkedin.com/company/… ou null", "explication": "une phrase"}\n("cible": true si le poste correspond aux postes prioritaires, false si décideur de repli)`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      })
    });

    let data = await r.json();
    if (r.status === 429) {
      await new Promise(x => setTimeout(x, 30000));
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        })
      });
      data = await r2.json();
      if (!r2.ok) return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || '' });
    } else if (!r.ok) {
      return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || JSON.stringify(data).slice(0, 200) });
    }

    await loggerConso(user, 'ia_claude', 1, (req.body && req.body.liste_id) || req.query.liste_id);
    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const debut = brut.indexOf('{');
    const finIdx = brut.lastIndexOf('}');
    let parsed = { personas: [], linkedin_entreprise: null, explication: 'Réponse IA non exploitable' };
    if (debut !== -1 && finIdx !== -1) {
      try { parsed = JSON.parse(brut.slice(debut, finIdx + 1)); } catch { /* garde le défaut */ }
    }
    parsed.personas = (parsed.personas || [])
      .filter(p => p && p.nom && p.confiance !== 'basse')
      .slice(0, 5);
    if (salariesBasile && salariesBasile.length) parsed.salaries = salariesBasile;

    return res.status(200).json({ ok: true, resultat: parsed });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
