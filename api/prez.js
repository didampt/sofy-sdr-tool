// /api/prez.js — 🎨 Générateur de présentations sales personnalisées.
//
// Ce qui rend le document impossible à ignorer : Sofy Scrap connaît déjà le prospect mieux que
// lui. Sa note Google, le nom de son pire point de vente, un VRAI avis de ses clients, la note
// moyenne de ses concurrents locaux, ses technos détectées, et maintenant ses signaux presse.
// Un concurrent ne peut pas produire la planche 2.
//
// POST { liste_id, cle_fiche, module, consigne? } → compose, stocke, renvoie l'URL publique
// GET  ?jeton=…      → relit une présentation (aperçu SDR)
// GET  ?mes=1        → mes présentations + compteur d'ouvertures (le signal chaud)
//
// ⚠️ RÈGLE ABSOLUE : l'IA n'écrit un chiffre que s'il vient des données MESURÉES du client ou
// d'un bloc de la base de connaissance AVEC sa source. Aucune statistique inventée, aucune
// promesse de résultat : ce document sort de l'entreprise et engage la parole de Sofy.

import { verifierToken, sql, ensureSchema, loggerConso } from './db.js';
import { blocsUtilisables } from './kb-sales.js';
import { cleRadar } from './radar.js';
import crypto from 'crypto';

export const config = { maxDuration: 300 };

const MODELE = () => process.env.MODELE_PREZ || 'claude-opus-5';
const BASE_PUB = () => process.env.SOFY_BASE_PUBLIQUE || 'https://www.sofyscrap.com';

let prezPrete = false;
async function ensurePrez() {
  if (prezPrete || !sql) return;
  // Table PARESSEUSE (pas de bump SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS prez (
    jeton TEXT PRIMARY KEY,
    client TEXT,
    module TEXT,
    sdr TEXT,
    liste_id INTEGER,
    cle_fiche TEXT,
    contenu JSONB NOT NULL,
    ouvertures INTEGER DEFAULT 0,
    profondeur INTEGER DEFAULT 0,
    premiere_ouverture TIMESTAMPTZ,
    derniere_ouverture TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_prez_sdr ON prez(sdr, created_at DESC)`;
  prezPrete = true;
}

const NOM_MODULE = { soview: 'Soview', soconnect: 'SoConnect', soreach: 'SoReach', tous: 'la suite Sofy' };

// Tout ce que Sofy Scrap sait déjà du prospect — c'est la matière de la planche 2
function mesures(e) {
  const g = e.gmb || {};
  const m = {
    nom: e.enseigne_ia || e.enseigne || e.nom,
    nom_legal: e.nom,
    ville: e.ville, code_postal: e.code_postal,
    activite: e.activite || e.secteur_rb2b || null,
    effectif: e.effectif || null,
    chiffre_affaires: e.chiffre_affaires || null,
    nb_etablissements: e.nb_etablissements || null,
    site_web: e.site_web || g.site_web || null
  };
  if (g.trouve) {
    m.google = {
      note_moyenne: g.note_moyenne, total_avis: g.total_avis, nb_fiches: g.nb_fiches,
      pire_fiche: g.pire_fiche ? { nom: g.pire_fiche.nom, note: g.pire_fiche.note, nb_avis: g.pire_fiche.nb_avis } : null,
      avis_negatif: g.avis_negatif ? { note: g.avis_negatif.note, date: g.avis_negatif.date, texte: g.avis_negatif.texte } : null,
      concurrents: g.concurrents ? { note_moyenne: g.concurrents.note_moyenne, secteur: g.concurrents.secteur, zone: g.concurrents.zone, nb_analyses: g.concurrents.nb_analyses } : null,
      ecart_concurrents: (g.concurrents && typeof g.note_moyenne === 'number')
        ? Math.round((g.concurrents.note_moyenne - g.note_moyenne) * 10) / 10 : null
    };
  } else m.google = { aucune_fiche_trouvee: true };
  if (e.technos_fait) {
    m.technos = (e.technos || []).map(t => ({ nom: t.nom, categorie: t.cat, concurrent_sofy: !!t.concurrent }));
    if (!m.technos.length) m.technos = 'aucun outil détecté sur le site';
  }
  if (e.signal_gmb) m.alerte_note = { avant: e.signal_gmb.avant, apres: e.signal_gmb.apres, date: e.signal_gmb.date };
  return m;
}

function prompt({ mes, radar, blocs, module, consigne, sdr }) {
  const parType = t => blocs.filter(b => b.type === t)
    .map(b => `• ${b.titre}${b.secteur ? ` [secteur : ${b.secteur}]` : ''}${b.territoire ? ` [territoire : ${b.territoire}]` : ''}\n  ${b.contenu}\n  SOURCE : ${b.source || 'interne'}`).join('\n');
  return `Tu rédiges une présentation commerciale personnalisée pour **un prospect précis**, au nom de **Sofy** (éditeur français : Soview = avis Google et visibilité locale · SoConnect = messagerie clients unifiée avec IA Budy · SoReach = campagnes SMS et RCS).

Module mis en avant : **${NOM_MODULE[module] || module}**. Commercial signataire : ${sdr || 'l\'équipe Sofy'}.
${consigne ? `\nCONSIGNE DU COMMERCIAL (prioritaire) : ${consigne}\n` : ''}
════ CE QUE NOUS AVONS MESURÉ CHEZ CE PROSPECT (données réelles, utilisables librement) ════
${JSON.stringify(mes, null, 1)}
${radar ? `\n════ CONTEXTE PRESSE RÉCENT (faits sourcés, chaque signal porte son URL) ════\n${JSON.stringify({ resume: radar.resume, signaux: (radar.signaux || []).map(s => ({ titre: s.titre, date: s.date, media: s.media, source_url: s.source_url })) }, null, 1)}\n` : ''}
════ BASE DE CONNAISSANCE SOFY — la SEULE source autorisée pour tout ce qui ne vient pas du prospect ════
CHIFFRES DE MARCHÉ :
${parType('chiffre_marche') || '(aucun)'}

ARGUMENTS ET PREUVES :
${parType('preuve') || '(aucun)'}

FONCTIONNALITÉS :
${parType('fonctionnalite') || '(aucune)'}

CAS CLIENTS CITABLES :
${parType('cas_client') || '(aucun)'}

CHARTE ET STYLE :
${parType('charte') || '(aucune)'}

════ RÈGLES ABSOLUES ════
1. **Aucun chiffre inventé.** Tu ne peux écrire un chiffre que s'il vient (a) des mesures du prospect ci-dessus, ou (b) d'un bloc de la base avec sa source. Interdiction formelle d'inventer une statistique de marché, un pourcentage de gain ou une promesse de résultat. Ce document sort de l'entreprise et engage la parole de Sofy.
2. **Ne promets aucun résultat.** Tu peux montrer ce qu'un autre client a obtenu (cas clients, avec la source) ; tu ne peux pas affirmer que ce prospect obtiendra la même chose. Formule la projection comme un objectif atteignable, jamais comme un engagement.
3. **Choisis le cas client le plus proche** en secteur et en territoire. Si aucun ne colle vraiment, dis-le franchement dans la planche 5 plutôt que d'en forcer un.
4. **Cite le prospect par son nom**, ses vrais chiffres, le vrai nom de son pire point de vente, un extrait de son vrai avis négatif. C'est ce qui prouve qu'on a travaillé pour lui.
5. Écris en français, à la deuxième personne du pluriel (« vous »). Ton : direct, factuel, respectueux. Jamais de flatterie, jamais de jargon marketing creux, jamais de point d'exclamation.
6. Si une mesure manque (pas de fiche Google, pas d'avis négatif), n'invente pas : construis la planche sur ce que tu as, ou signale l'absence comme un constat en soi (« aucune fiche Google trouvée » est un problème à nommer).

════ STRUCTURE — 7 planches, dans cet ordre ════
Réponds UNIQUEMENT par cet objet JSON, sans texte autour, sans backticks :
{
 "titre_document": "Analyse Sofy — <Nom du prospect>",
 "sous_titre": "une ligne qui situe l'analyse",
 "planches": [
  {"n":1,"role":"couverture","eyebrow":"PRÉPARÉ POUR VOUS","titre":"titre de couverture qui nomme le prospect","texte":"une phrase : qui a préparé ce document et pourquoi"},
  {"n":2,"role":"constat","eyebrow":"CE QUE NOUS AVONS OBSERVÉ","titre":"…","texte":"introduction en une ou deux phrases","chiffres":[{"valeur":"3,4 ★","legende":"votre note Google sur 7 fiches","source":"mesuré sur vos fiches Google"}],"citation":{"texte":"extrait du vrai avis négatif","meta":"Avis Google · <nom de la fiche> · <date>"}},
  {"n":3,"role":"cout","eyebrow":"CE QUE ÇA VOUS COÛTE","titre":"…","texte":"…","points":[{"titre":"…","texte":"…","source":"la source du bloc utilisé"}]},
  {"n":4,"role":"solution","eyebrow":"COMMENT ON CORRIGE","titre":"…","texte":"…","points":[{"titre":"…","texte":"…"}]},
  {"n":5,"role":"preuve","eyebrow":"ILS L'ONT FAIT AVANT VOUS","titre":"…","texte":"pourquoi ce cas ressemble au sien","chiffres":[{"valeur":"+30 %","legende":"…","source":"…"}],"citation":{"texte":"verbatim du client","meta":"<Client> · interview publiée"}},
  {"n":6,"role":"projection","eyebrow":"VOTRE PROJECTION","titre":"…","texte":"reprend les mêmes indicateurs que la planche 2, corrigés — formulés comme objectif, pas comme promesse","points":[{"titre":"…","texte":"…"}]},
  {"n":7,"role":"cta","eyebrow":"ON EN PARLE ?","titre":"…","texte":"…","cta":"15 minutes pour en parler"}
 ]
}

Chaque "source" doit être recopiée telle quelle depuis la base ou dire « mesuré sur vos fiches Google » / « votre site » quand la donnée vient du prospect. Une planche sans donnée disponible peut avoir un tableau vide, mais jamais un chiffre sans source.`;
}

async function composer(ctx) {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { erreur: 'CLAUDE_API_KEY manquante' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE(), max_tokens: 8000,
      output_config: { effort: 'high' }, // rédaction commerciale : la qualité prime ici
      messages: [{ role: 'user', content: prompt(ctx) }]
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { erreur: 'API Claude', detail: (d.error && d.error.message) || JSON.stringify(d).slice(0, 200) };
  const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/```json|```/g, '').trim();
  const a = t.indexOf('{'), b2 = t.lastIndexOf('}');
  if (a < 0 || b2 <= a) return { erreur: 'Réponse IA non exploitable' };
  try { return { ok: true, doc: JSON.parse(t.slice(a, b2 + 1)), usage: d.usage || null }; }
  catch (e) { return { erreur: 'JSON invalide dans la réponse IA' }; }
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  await ensurePrez();

  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.mes === '1') {
      // L'historique porte le signal : « ouverte 3 fois » vaut mieux qu'un email ouvert
      const rows = await sql`SELECT jeton, client, module, sdr, ouvertures, profondeur,
          premiere_ouverture, derniere_ouverture, created_at FROM prez
        WHERE (${['admin', 'superadmin'].includes(user.role)} OR sdr = ${user.nom})
        ORDER BY created_at DESC LIMIT 50`;
      return res.status(200).json({
        ok: true,
        prez: rows.map(r => ({ ...r, url: BASE_PUB() + '/p/' + r.jeton }))
      });
    }
    if (q.jeton) {
      const [row] = await sql`SELECT * FROM prez WHERE jeton = ${String(q.jeton)}`;
      if (!row) return res.status(404).json({ erreur: 'Présentation introuvable' });
      return res.status(200).json({ ok: true, prez: row, url: BASE_PUB() + '/p/' + row.jeton });
    }
    return res.status(400).json({ erreur: 'jeton ou mes=1 requis' });
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST' });
  const b = req.body || {};
  const module = ['soview', 'soconnect', 'soreach', 'tous'].includes(b.module) ? b.module : 'tous';

  try {
    // ── La fiche du prospect : c'est elle qui rend le document impossible à copier ──
    let ent = null;
    if (b.liste_id && b.cle_fiche) {
      const [l] = await sql`SELECT entreprises FROM listes WHERE id = ${parseInt(b.liste_id)}`;
      const arr = (l && Array.isArray(l.entreprises)) ? l.entreprises : [];
      const cle = String(b.cle_fiche).toLowerCase();
      ent = arr.find(e => {
        const n = String(e.nom || '').toLowerCase(), en = String(e.enseigne_ia || e.enseigne || '').toLowerCase();
        return n === cle || en === cle || (e.siren && String(e.siren) === cle) ||
          n.includes(cle) || cle.includes(n);
      }) || null;
    } else if (b.entreprise) ent = b.entreprise; // appel direct (test)
    if (!ent) return res.status(404).json({ erreur: 'Fiche introuvable — passe liste_id + cle_fiche' });

    const mes = mesures(ent);
    // Le contexte presse du radar enrichit la planche 2 quand il existe (jamais bloquant)
    let radar = null;
    try {
      const cle = cleRadar({ site: mes.site_web, nom: mes.nom_legal, enseigne: mes.nom });
      if (cle) {
        const [c] = await sql`SELECT resultat FROM radar_cache WHERE cle = ${cle} AND resultat ? 'signaux'`;
        if (c && (c.resultat.signaux || []).length) radar = c.resultat;
      }
    } catch (_) {}

    const blocs = await blocsUtilisables(module);
    if (!blocs.length) return res.status(400).json({ erreur: 'Base de connaissance vide — lance l\'amorçage (POST /api/kb-sales { seed: true })' });

    const out = await composer({ mes, radar, blocs, module, consigne: b.consigne, sdr: user.nom });
    if (out.erreur) return res.status(502).json(out);

    const jeton = crypto.randomBytes(9).toString('base64url'); // 12 caractères, non devinable
    await sql`INSERT INTO prez (jeton, client, module, sdr, liste_id, cle_fiche, contenu)
      VALUES (${jeton}, ${mes.nom || ''}, ${module}, ${user.nom}, ${b.liste_id ? parseInt(b.liste_id) : null},
              ${b.cle_fiche || null}, ${JSON.stringify({ ...out.doc, _mes: mes, _sdr: user.nom, _module: module })}::jsonb)`;
    try { await loggerConso(user, 'ia_claude', 1, b.liste_id || null); } catch (_) {}

    return res.status(200).json({
      ok: true, jeton, url: BASE_PUB() + '/p/' + jeton, client: mes.nom, module,
      planches: (out.doc.planches || []).length,
      contexte_utilise: { radar: !!radar, blocs_kb: blocs.length, cas_clients: blocs.filter(x => x.type === 'cas_client').length },
      doc: out.doc
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Génération impossible', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
