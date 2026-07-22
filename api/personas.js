// /api/personas.js — Wave 2 : trouver les PERSONNES aux postes ciblés (Dir Commercial, Dir Réseau…)
// POST {entreprise:{nom, enseigne, site, ville, linkedin}, jobs:["Dir Marketing", …]}
//   → {personas:[{prenom, nom, fonction, linkedin, confiance, cible}]}
//
// Waterfall (v244) :
//   1. Basile /people/find par EMPLOYEUR — salariés LinkedIn + dirigeants du registre, données réelles
//      (~0,01 €, zéro hallucination, profils non indexés par Google inclus). Filtre postes côté serveur
//      car le champ current_job_functions de Basile est peu fiable (testé : "Marketing" → 0 résultat).
//   2. Repli : agent Claude + recherche web (ancien comportement) uniquement si Basile ne donne rien.
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
  'head', 'chef', 'manager', 'adjoint', 'adjointe', 'de', 'du', 'des', 'le', 'la', 'les', 'et', 'd', 'l', 'of', 'the']);
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

async function personasBasile(entreprise, jobs, cle) {
  const valeurs = valeursEmployeur(entreprise);
  if (!valeurs.length) return null;

  const r = await fetch('https://api.basile.cc/people/find', {
    method: 'POST',
    headers: { 'Authorization': cle, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100, filters: { employer: { include: valeurs }, hide_legal_entities: true } })
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.success === false) return null;

  const refs = [entreprise.enseigne, entreprise.nom, racineDomaine(entreprise.site)]
    .map(x => normaliser(x || '').replace(/ /g, '')).filter(x => x.length >= 4);
  const { mots, generique } = motsClesJobs(jobs);

  const cibles = [], replis = [], vus = new Set();
  for (const lead of ((d && d.leads) || [])) {
    const x = lead.data || lead || {};
    const prenom = x.people_first_name || x.result_first_name || '';
    const nomC = x.people_last_name || x.result_last_name || '';
    if (!nomC && !prenom) continue;
    const kNom = normaliser(prenom + ' ' + nomC);
    if (vus.has(kNom)) continue;
    if (!memeEntreprise(x.current_company_name || x.legal_name || '', refs)) continue;

    const fonction = x.result_role || x.current_job_title || '';
    if (EXCLUS_FONCTION.test(fonction)) continue;
    const fn = normaliser(fonction);

    const p = {
      prenom, nom: nomC, fonction: fonction || 'Contact',
      linkedin: x.profile_url || null, confiance: 'haute'
    };
    if (mots.some(m => fn.includes(m)) || (generique && REPLI_DECIDEUR.test(fn))) {
      p.cible = true; cibles.push(p); vus.add(kNom);
    } else if (REPLI_DECIDEUR.test(fn)) {
      p.cible = false; replis.push(p); vus.add(kNom);
    }
  }

  const personas = cibles.concat(replis.slice(0, 2)).slice(0, 5);
  if (!personas.length) return null;
  return {
    personas,
    linkedin_entreprise: null,
    explication: `${personas.length} contact(s) trouvés via Basile (salariés LinkedIn + registre légal)${replis.length && cibles.length ? ', décideurs de repli inclus' : ''}`
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

  const { entreprise = {}, jobs = [] } = req.body || {};
  if (!entreprise.nom || !jobs.length) return res.status(400).json({ erreur: 'entreprise.nom et jobs requis' });

  try {
    // ── Étape 1 : Basile (pas cher, données réelles) ──
    if (process.env.BASILE_API_KEY) {
      let viaBasile = null;
      try { viaBasile = await personasBasile(entreprise, jobs, process.env.BASILE_API_KEY); } catch (_) { viaBasile = null; }
      if (viaBasile) {
        await loggerConso(user, 'basile', 1, (req.body && req.body.liste_id) || req.query.liste_id);
        return res.status(200).json({ ok: true, resultat: viaBasile });
      }
    }

    // ── Étape 2 : repli — agent Claude + recherche web (ancien comportement) ──
    const prompt = `Tu es un assistant de prospection B2B. Trouve les PERSONNES occupant actuellement ces postes dans cette entreprise française :

Entreprise : ${entreprise.nom}${entreprise.enseigne ? ` (enseigne : ${entreprise.enseigne})` : ''}
${entreprise.site ? `Site web : ${entreprise.site}` : ''}
${entreprise.linkedin ? `Page LinkedIn de l'entreprise (déjà connue, utilise-la directement) : ${entreprise.linkedin}` : ''}
Ville : ${entreprise.ville || ''}
Postes recherchés en priorité : ${jobs.join(', ')}
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
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
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
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
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

    return res.status(200).json({ ok: true, resultat: parsed });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
