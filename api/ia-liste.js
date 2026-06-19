// /api/ia-liste.js — Cerveau IA de la "Liste intelligente".
// Reçoit le prompt libre du SDR, et renvoie :
//   - des critères structurés exploitables par Basile (entreprises + personnes)
//   - une reformulation lisible, des questions d'affinage, un conseil orienté Sofy
//
// POST { prompt, reponses? }
//   prompt   = texte libre du SDR (ex : "je veux des dir. co dans l'auto en France et à la Réunion")
//   reponses = (optionnel) objet { effectif, ca, nb_contacts } saisi par le SDR au 2e tour
//
// Réponse : { criteres:{...}, reformulation, questions:[...], conseil }
// Claude répond en JSON strict (parsé côté serveur).

const ANTHRO = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `Tu es l'assistant de ciblage commercial de Sofy, un SaaS B2B français.
Ton rôle : transformer la demande en langage naturel d'un commercial (SDR) en critères de recherche structurés pour la base de données B2B française "Basile" (sources : registre légal INSEE/INPI + LinkedIn + Google My Business).

Tu connais le contexte Sofy : Sofy vend à des commerces et entreprises multi-établissements en France métropolitaine, Antilles et Réunion. Les cibles pertinentes sont plutôt des PME/ETI à plusieurs établissements (pas des TPE isolées).

Tu réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, sans balises Markdown. Structure EXACTE attendue :

{
  "criteres": {
    "naf_codes": ["45.11Z", "45.20A"],        // codes NAF exacts si identifiables (format NN.NNL), sinon []
    "activite_libre": "concessionnaires automobiles",  // description courte de l'activité visée
    "postes": ["Directeur Commercial", "Directeur de la Communication", "Responsable Relation Client", "Responsable CRM"],  // intitulés de postes en français ET anglais (varie les formulations)
    "seniorites": ["C-Level", "Director", "Head", "VP"],  // parmi : C-Level, Director, VP, Head, Manager
    "pays": ["FR"],                            // toujours FR pour l'instant
    "zones": ["metropole", "974"],             // "metropole" et/ou codes DOM (971,972,973,974,976)
    "effectif_min": null,                      // nombre ou null
    "effectif_max": null,                      // nombre ou null
    "ca_min": null,                            // nombre en euros ou null
    "nb_contacts": null                        // nombre souhaité ou null
  },
  "reformulation": "Phrase claire résumant ce que tu as compris (secteur, postes, zone).",
  "questions": [
    "Question d'affinage 1 (ex : quelle taille d'entreprise ?)",
    "Question d'affinage 2 (ex : un CA minimum ?)"
  ],
  "conseil": "Un conseil pertinent orienté Sofy pour améliorer le ciblage (ex : privilégier les multi-établissements). Vide si rien d'utile."
}

Règles importantes :
- Pour les postes, génère plusieurs variantes (français + anglais + abréviations) pour maximiser les résultats. Ex pour directeur marketing : "Directeur Marketing", "CMO", "Chief Marketing Officer", "Head of Marketing".
- Si le SDR mentionne une entreprise de référence (ex : "comme le groupe GBH"), identifie son secteur et propose des entreprises similaires via le NAF / l'activité — NE mets PAS l'entreprise de référence elle-même dans les critères.
- Pour les zones : "France" ou "France métropolitaine" => "metropole". "Réunion" => "974". "Guadeloupe" => "971". "Martinique" => "972". "Guyane" => "973". "Mayotte" => "976". Antilles => ["971","972"].
- Si l'effectif / CA / nb de contacts sont déjà donnés dans la demande, remplis-les. Sinon laisse null ET pose la question correspondante.
- Maximum 3 questions. Ne pose que des questions utiles (ne redemande pas ce qui est déjà clair).
- Le conseil doit être court (1-2 phrases) et concret.`;

export default async function handler(req, res) {
  // Auth interne (import dynamique pour rester cohérent avec les autres endpoints)
  const { verifierToken } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante' });

  const { prompt, reponses } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    return res.status(400).json({ erreur: 'prompt requis (au moins quelques mots)' });
  }

  // Message utilisateur : le prompt + éventuellement les réponses d'affinage du 2e tour
  let contenu = `Demande du commercial :\n"${prompt.trim()}"`;
  if (reponses && typeof reponses === 'object') {
    const bits = [];
    if (reponses.effectif) bits.push(`Effectif souhaité : ${reponses.effectif}`);
    if (reponses.ca) bits.push(`CA minimum : ${reponses.ca}`);
    if (reponses.nb_contacts) bits.push(`Nombre de contacts visé : ${reponses.nb_contacts}`);
    if (bits.length) contenu += `\n\nPrécisions déjà fournies :\n` + bits.join('\n') + `\n\nIntègre ces précisions dans les critères et ne repose pas ces questions.`;
  }

  try {
    const r = await fetch(ANTHRO, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: 'user', content: contenu }]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ erreur: 'Erreur IA', detail: JSON.stringify(data.error || data).slice(0, 200) });
    }

    // Extraire le texte renvoyé par Claude
    const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Parser le JSON (robuste : enlève d'éventuelles balises Markdown)
    let parsed = null;
    try {
      const clean = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ erreur: 'Réponse IA non exploitable', brut: txt.slice(0, 300) });
    }

    // Garde-fous : structure minimale
    if (!parsed.criteres) parsed.criteres = {};
    if (!Array.isArray(parsed.questions)) parsed.questions = [];
    if (typeof parsed.reformulation !== 'string') parsed.reformulation = '';
    if (typeof parsed.conseil !== 'string') parsed.conseil = '';

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur appel IA', detail: String(e.message || e).slice(0, 200) });
  }
}
