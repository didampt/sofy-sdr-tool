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
    "postes": ["Directeur Commercial", "Directeur de la Communication"],  // INDICATIF seulement (lisibilité), PAS utilisé pour filtrer
    "familles_poste": ["marketing", "relation_client"],  // OBLIGATOIRE : 1+ familles parmi la liste fixe (voir règle). C'est CE champ qui cible les postes.
    "seniorites": ["C-Level", "Director", "Head", "VP"],  // parmi : C-Level, Director, VP, Head, Manager
    "pays": ["FR"],                            // toujours FR pour l'instant
    "zones": ["metropole", "974"],             // "metropole" et/ou codes DOM (971,972,973,974,976)
    "effectif_min": null,                      // nombre ou null (tranche d'effectif salarié)
    "effectif_max": null,                      // nombre ou null
    "nb_contacts": null,                       // nombre souhaité ou null
    "secteur_basile": null                     // UN macro-secteur (ou null) parmi : commerce, btp, transport, hospitality, agriculture, finance, manufacturing
  },
  "reformulation": "Phrase claire résumant ce que tu as compris (secteur, postes, zone).",
  "questions": [
    "Question d'affinage 1 (ex : quelle taille d'entreprise en effectif ?)",
    "Question d'affinage 2 (ex : combien de contacts veux-tu au total ?)"
  ],
  "conseil": "Un conseil pertinent orienté Sofy pour améliorer le ciblage (ex : privilégier les multi-établissements). Vide si rien d'utile."
}

Règles importantes :
- familles_poste : c'est LE champ qui pilote le ciblage des postes (le serveur transforme chaque famille en une liste d'intitulés figée — résultat 100% stable). Classe la demande dans une ou plusieurs familles parmi EXACTEMENT cette liste : "direction", "commercial", "marketing", "communication", "digital", "relation_client", "experience_client", "crm", "acquisition". Ex : "directeur marketing et directeur expérience client" => ["marketing","experience_client"] ; "le dirigeant / la tête de réseau" => ["direction"]. N'invente JAMAIS d'autres clés. Le champ "postes" est seulement indicatif.
- Le SECTEUR sert à deux choses : (a) orienter les intitulés de poste ; (b) remplir naf_codes. Pour naf_codes, choisis 2 à 4 codes MAXIMUM, les plus SPÉCIFIQUES au cœur de l'activité décrite (ex : vente de pièces auto = 45.31Z commerce de gros d'équipements automobiles + 45.32Z commerce de détail d'équipements automobiles). N'ajoute PAS de codes génériques (46.90Z commerce de gros non spécialisé) ni d'activités seulement adjacentes (vente de véhicules 45.11Z/45.19Z, réparation 45.20A/B) si la demande porte sur les PIÈCES. Exactitude > exhaustivité : ces mêmes codes seront aussi générés à l'identique d'une fois sur l'autre.
- secteur_basile : classe l'activité visée dans UN de ces 7 macro-secteurs Basile (ou null si rien ne colle) : "commerce" (commerce, retail, distribution, vente, magasins, e-commerce, grossistes, automobile, pièces auto), "btp" (bâtiment, travaux, construction, immobilier, agences immobilières), "transport" (transport, logistique, livraison), "hospitality" (restauration, hôtellerie, cafés, bars, tourisme), "agriculture" (agriculture, agroalimentaire), "finance" (banque, assurance, finance, comptabilité), "manufacturing" (industrie, fabrication, production). Ex : restauration rapide => "hospitality" ; concessionnaire/pièces auto => "commerce" ; agence immobilière => "btp". Ce champ filtre les PERSONNES par secteur (combiné au poste) — c'est le seul filtre secteur qui marche sur les personnes.
- Si le SDR mentionne une entreprise de référence (ex : "comme le groupe GBH"), identifie son secteur et propose des entreprises similaires via le NAF / l'activité — NE mets PAS l'entreprise de référence elle-même dans les critères.
- Pour les zones : "France" ou "France métropolitaine" => "metropole". "Réunion" => "974". "Guadeloupe" => "971". "Martinique" => "972". "Guyane" => "973". "Mayotte" => "976". Antilles => ["971","972"].
- Si l'effectif / CA / nb de contacts sont déjà donnés dans la demande, remplis-les. Sinon laisse null ET pose la question correspondante.
- Maximum 3 questions. Ne pose que des questions utiles (ne redemande pas ce qui est déjà clair).
- Le conseil doit être court (1-2 phrases) et concret.
- IMPORTANT : la base de données ne permet PAS de filtrer par chiffre d'affaires ni par nombre d'établissements/points de vente. Ne propose JAMAIS ces critères comme filtres. Si le commercial les mentionne (ex : "au moins 3 points de vente", "CA > 2M"), reformule en disant que tu cibleras plutôt par taille d'effectif et secteur, et que ces critères précis pourront être affinés manuellement après. Le seul critère de taille disponible est l'effectif salarié (effectif_min/max).`;

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
    if (reponses.nb_contacts) bits.push(`Nombre de contacts visé : ${reponses.nb_contacts}`);
    if (bits.length) contenu += `\n\nPrécisions déjà fournies :\n` + bits.join('\n') + `\n\nIntègre ces précisions dans les critères et ne repose pas ces questions.`;
  }

  try {
    const appel = () => fetch(ANTHRO, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: contenu }]
      })
    });
    // Relance auto : 529 (surcharge) / 429 (débit) / coupure réseau → on patiente et on réessaie (3 tentatives)
    let r, data, tentative = 0;
    while (true) {
      tentative++;
      try { r = await appel(); }
      catch (netErr) { if (tentative < 3) { await new Promise(s => setTimeout(s, 700 * tentative)); continue; } throw netErr; }
      data = await r.json().catch(() => ({}));
      if ((r.status === 529 || r.status === 429) && tentative < 3) { await new Promise(s => setTimeout(s, 700 * tentative)); continue; }
      break;
    }
    if (!r.ok) {
      const surcharge = (r.status === 529 || r.status === 429);
      return res.status(surcharge ? 503 : 502).json({ erreur: surcharge ? 'Le service IA est momentanément saturé. Réessaie dans quelques secondes.' : 'Erreur IA', detail: JSON.stringify(data.error || data).slice(0, 200) });
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
