// /api/kb-ingest.js — 📥 Alimenter la base de connaissance sans savoir la remplir.
//
// Demande de Didier : « que les SDR, AE et le CMO puissent ajouter des documents, URL, FAQ, PDF ».
// Personne ne va découper un PDF de 130 pages en blocs typés à la main. Claude le fait : il lit
// la source, en extrait des blocs candidats, et les dépose **en proposition**. Un admin valide.
//
// POST { url }                    → Claude lit la page et propose des blocs
// POST { texte }                  → un texte collé (FAQ, notes, argumentaire)
// POST { fichier: {nom, type, b64} } → PDF ou image (capture d'écran de slide, plaquette)
//
// ⚠️ L'extraction ne valide JAMAIS toute seule, même pour un admin : ce qui sort d'ici est une
// lecture automatique d'un document, et c'est précisément le genre de contenu qu'il faut relire
// avant qu'il parte dans un document au nom de Sofy.

import { verifierToken, sql } from './db.js';
import { TYPES_KB, MODULES_KB, ensureKbPublique } from './kb-sales.js';

export const config = { maxDuration: 300 };

const MODELE = () => process.env.MODELE_KB || 'claude-opus-5';
// 4,5 Mo est la limite du corps de requête Vercel ; le base64 pèse ~1,37× le fichier.
const MAX_B64 = 3_000_000;
// Réseaux sociaux : l'outil web_fetch reçoit un « url_not_allowed » et l'appel coûte quand même.
// Autant le dire tout de suite et proposer la voie qui marche, plutôt que facturer un refus.
const MURS = [
  { re: /(^|\.)linkedin\.com$/i, nom: 'LinkedIn' },
  { re: /(^|\.)facebook\.com$/i, nom: 'Facebook' },
  { re: /(^|\.)instagram\.com$/i, nom: 'Instagram' },
  { re: /(^|\.)(x|twitter)\.com$/i, nom: 'X' },
  { re: /(^|\.)tiktok\.com$/i, nom: 'TikTok' },
  { re: /(^|\.)threads\.(net|com)$/i, nom: 'Threads' }
];

const TYPES_FICHIER = {
  'application/pdf': 'document',
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image'
};

function prompt({ origine, module }) {
  return `Tu alimentes la base de connaissance commerciale de **Sofy** (éditeur français : Soview = avis Google et visibilité locale · SoConnect = messagerie clients unifiée · SoReach = SMS et RCS).

Cette base sert à un générateur de présentations client. Chaque bloc que tu produis pourra être recopié dans un document qui sort de l'entreprise et engage la parole de Sofy. Tu extrais donc du **fait vérifiable**, jamais de l'enrobage marketing.

SOURCE À DÉPOUILLER : ${origine}
${module && module !== 'tous' ? `Module concerné en priorité : ${module}.` : ''}

TYPES DE BLOCS (choisis le plus juste pour chacun) :
· chiffre_marche — une statistique de marché ou de comportement client. **Interdit sans source précise.**
· preuve — un argument étayé, un mécanisme expliqué (ex : pourquoi la cohérence NAP compte)
· fonctionnalite — ce que le produit fait concrètement
· cas_client — un client nommé, ses résultats chiffrés. **Interdit sans source.** Renseigne "secteur" et "territoire" : c'est ce qui permet de servir le bon cas au bon prospect.
· objection — une objection entendue en rendez-vous et la réponse factuelle à y apporter
· tarif — un prix (sera réservé aux admins)

RÈGLES
1. **Zéro invention.** Si un chiffre n'est pas explicitement dans la source, il n'existe pas. Ne complète pas, ne déduis pas, n'arrondis pas.
2. **La source de chaque bloc doit permettre de retrouver le fait** : nom du document et page, nom de l'étude et année, URL. « interne » n'est acceptable que pour un argument non chiffré.
3. Si la source est un document commercial d'un **concurrent**, tu peux en extraire des blocs de type "objection" (comment répondre à cet argument) — jamais de "preuve" attribuée à Sofy.
4. Un bloc = une idée autonome, compréhensible sans le reste du document. Titre ≤ 90 caractères, contenu de 200 à 700 caractères. Le **gras** en \`**texte**\` est autorisé dans le contenu.
5. Entre 1 et 12 blocs. Mieux vaut 3 blocs solides que 12 délayés. Si la source ne contient rien d'exploitable, renvoie une liste vide et dis pourquoi dans "commentaire".

Réponds UNIQUEMENT par ce JSON, sans texte autour, sans backticks :
{
 "commentaire": "ce que tu as lu et ce que tu en as tiré, 1 à 2 phrases",
 "blocs": [
  {"type":"cas_client","module":"soview","titre":"…","contenu":"…","source":"…","secteur":"…","territoire":"…"}
 ]
}`;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureKbPublique();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY absente' });

  const b = req.body || {};
  const module = MODULES_KB.includes(b.module) ? b.module : 'tous';

  // ── Constitution du message selon la nature de la source ──
  let contenuMsg = [], origine = '';
  let outils = null;

  if (b.url) {
    const u = String(b.url).trim();
    if (!/^https?:\/\//i.test(u)) return res.status(400).json({ erreur: 'URL invalide (elle doit commencer par http)' });
    let hote = '';
    try { hote = new URL(u).hostname; } catch (_) {}
    const mur = MURS.find(m => m.re.test(hote));
    if (mur) {
      return res.status(422).json({
        erreur: `${mur.nom} bloque la lecture automatique`,
        detail: `Aucune requête n'a été lancée — ça t'évite de payer une lecture qui échoue. Ouvre le post, sélectionne son texte, et colle-le dans l'onglet « 📝 Texte collé » en indiquant l'auteur et la date comme source (ex. « Post LinkedIn de Sarah El Moubarak, 08/2026 »). Une capture d'écran passe aussi par « 📎 PDF ou image ».`,
        alternative: 'texte'
      });
    }
    origine = `la page web ${u}`;
    // Claude va chercher la page lui-même : pas de limite de taille de notre côté, et la source
    // reste rafraîchissable — il suffit de relancer l'ingestion sur la même URL.
    outils = [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 40000 }];
    contenuMsg = [{ type: 'text', text: prompt({ origine, module }) + `\n\nCommence par récupérer ${u} avec l'outil web_fetch. Si la page est inaccessible, dis-le dans "commentaire" et renvoie une liste vide.` }];
  } else if (b.texte) {
    const t = String(b.texte).slice(0, 200000);
    if (t.trim().length < 40) return res.status(400).json({ erreur: 'Texte trop court pour en tirer quoi que ce soit' });
    origine = b.origine ? String(b.origine).slice(0, 200) : 'un texte fourni par ' + user.nom;
    contenuMsg = [{ type: 'text', text: prompt({ origine, module }) + '\n\n════ TEXTE À DÉPOUILLER ════\n' + t }];
  } else if (b.fichier && b.fichier.b64) {
    const f = b.fichier;
    const genre = TYPES_FICHIER[f.type];
    if (!genre) {
      return res.status(400).json({
        erreur: `Format non lisible : ${f.type || 'inconnu'}`,
        detail: 'PDF, PNG, JPEG et WebP sont acceptés. Un PowerPoint doit être exporté en PDF (Fichier › Exporter) — le .pptx lui-même n\'est pas lisible.'
      });
    }
    if (String(f.b64).length > MAX_B64) {
      return res.status(413).json({ erreur: 'Fichier trop lourd (limite ≈ 2 Mo)', detail: 'Découpe le document ou envoie les pages utiles.' });
    }
    origine = `le fichier « ${String(f.nom || 'sans nom').slice(0, 120)} »`;
    contenuMsg = [
      genre === 'document'
        ? { type: 'document', source: { type: 'base64', media_type: f.type, data: f.b64 } }
        : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.b64 } },
      { type: 'text', text: prompt({ origine, module }) }
    ];
  } else {
    return res.status(400).json({ erreur: 'Donne une url, un texte ou un fichier' });
  }

  // ── Appel Claude ──
  const corps = {
    model: MODELE(), max_tokens: 8000,
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: contenuMsg }]
  };
  if (outils) corps.tools = outils;

  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(corps)
    });
    data = await r.json();
    // Repli si le compte n'expose pas encore l'outil web_fetch 2026
    if (!r.ok && outils && /web_fetch_20260209|tool/i.test(JSON.stringify(data.error || ''))) {
      corps.tools = [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 40000 }];
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(corps)
      });
      data = await r2.json();
      if (!r2.ok) return res.status(502).json({ erreur: 'API Claude', detail: String((data.error && data.error.message) || '').slice(0, 250) });
    } else if (!r.ok) {
      return res.status(502).json({ erreur: 'API Claude ' + r.status, detail: String((data.error && data.error.message) || '').slice(0, 250) });
    }
  } catch (e) {
    return res.status(502).json({ erreur: 'Lecture interrompue', detail: String((e && e.message) || e).slice(0, 200) });
  }

  const txt = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
    .replace(/```(?:json)?/g, '').trim();
  let doc;
  try { doc = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch (_) { return res.status(502).json({ erreur: 'Réponse illisible de Claude', detail: txt.slice(0, 200) }); }

  // ── Dépôt en proposition ──
  const proposes = [], rejetes = [];
  for (const x of (doc.blocs || []).slice(0, 12)) {
    if (!x || !x.titre || !x.contenu) continue;
    const type = TYPES_KB.includes(x.type) ? x.type : 'preuve';
    // Même garde-fou qu'à la saisie manuelle : un chiffre ou un cas client sans source n'entre pas
    if (['chiffre_marche', 'cas_client'].includes(type) && !String(x.source || '').trim()) {
      rejetes.push({ titre: x.titre, motif: 'chiffre ou cas client sans source' });
      continue;
    }
    try {
      const [row] = await sql`INSERT INTO kb_sales (type, module, titre, contenu, source, secteur, territoire,
          verifie_le, statut, propose_par)
        VALUES (${type}, ${MODULES_KB.includes(x.module) ? x.module : module}, ${String(x.titre).slice(0, 300)},
                ${String(x.contenu).slice(0, 4000)}, ${x.source ? String(x.source).slice(0, 500) : null},
                ${x.secteur || null}, ${x.territoire || null}, CURRENT_DATE, 'propose',
                ${user.nom + ' (lecture IA)'}) RETURNING id, type, titre, source`;
      proposes.push(row);
    } catch (e) { rejetes.push({ titre: x.titre, motif: String((e && e.message) || e).slice(0, 100) }); }
  }

  const u = data.usage || {};
  return res.status(200).json({
    ok: true, origine, commentaire: doc.commentaire || '',
    proposes, rejetes, total: proposes.length,
    info: proposes.length
      ? `${proposes.length} bloc(s) déposé(s) en proposition. Un admin les valide avant que l'IA s'en serve.`
      : 'Rien d\'exploitable n\'a été extrait de cette source.',
    cout_estime_eur: Math.round(((u.input_tokens || 0) * 5 + (u.output_tokens || 0) * 25) / 1e6 * 100) / 100
  });
}
