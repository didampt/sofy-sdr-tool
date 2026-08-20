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
import { blocsUtilisables, amorcer } from './kb-sales.js';
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
  // Durée de vie limitée (décision Didier) : un lien qui traîne finit par montrer des données
  // périmées à un prospect, et le stockage n'a pas à croître indéfiniment.
  await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS expire_le TIMESTAMPTZ`;
  await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS lecteurs JSONB DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS destinataire TEXT`;
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
      telephone: g.telephone || null, site_declare: g.site_web || null,
      // La liste complète : c'est elle qui permet de reproduire la fiche à l'écran et de pointer
      // les divergences entre points de vente d'un même réseau.
      fiches: (g.fiches || []).slice(0, 5).map(f => ({
        nom: f.nom, note: f.note, nb_avis: f.nb_avis, adresse: f.adresse || null
      })),
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

  // Défauts de fiche relevés par le code, pas déduits par l'IA : ce sont des faits opposables,
  // et c'est ce que Didier veut voir en face d'une brique Sofy (« les erreurs retrouvées sur
  // la fiche GMB de Veepee »).
  if (g.trouve) {
    const d = [];
    const fs = g.fiches || [];
    if (!g.telephone) d.push('Aucun numéro de téléphone sur la fiche Google : un client qui veut joindre le service ne trouve pas de numéro et repart.');
    if (!g.site_web) d.push('Aucun site web déclaré sur la fiche Google : le trafic que Google vous envoie n\'atterrit nulle part.');
    if (fs.length > 1) {
      const notes = fs.filter(f => typeof f.note === 'number').map(f => f.note);
      if (notes.length > 1) {
        const ecart = Math.round((Math.max(...notes) - Math.min(...notes)) * 10) / 10;
        if (ecart >= 0.5) d.push(`Vos ${fs.length} fiches vont de ${String(Math.min(...notes)).replace('.', ',')}★ à ${String(Math.max(...notes)).replace('.', ',')}★ : ${ecart.toString().replace('.', ',')} point d'écart entre vos points de vente, donc aucune expérience homogène de votre marque.`);
      }
      const sansAdresse = fs.filter(f => !f.adresse).length;
      if (sansAdresse) d.push(`${sansAdresse} de vos fiches n'ont pas d'adresse exploitable : Google ne peut pas les rattacher à une zone, elles ne sortent pas sur « près de moi ».`);
      const noms = new Set(fs.map(f => String(f.nom || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
      if (noms.size === fs.length && fs.length > 2) d.push('Vos fiches portent des libellés tous différents : pour Google et pour les assistants IA, ce sont autant d\'entreprises distinctes plutôt qu\'un réseau.');
    }
    const faibles = fs.filter(f => typeof f.note === 'number' && f.note < 3);
    if (faibles.length) d.push(`${faibles.length} fiche(s) sous 3★ tirent la moyenne du réseau vers le bas — dont ${faibles[0].nom} à ${String(faibles[0].note).replace('.', ',')}★.`);
    if (d.length) m.defauts_fiche = d;
  }
  if (e.technos_fait && Array.isArray(e.technos) && !e.technos.some(t => /avis|review|reput/i.test(String(t.nom) + String(t.cat)))) {
    m.defauts_fiche = (m.defauts_fiche || []).concat("Aucun outil de collecte ou de réponse aux avis détecté sur le site : la réputation n'est pilotée par personne, elle subit ce que les clients publient.");
  }
  return m;
}

// Le logo du prospect sur la couverture : c'est le premier signal que le document a été fait
// pour LUI. On le récupère sur son propre site (og:image, apple-touch-icon, favicon) et on
// l'inline en data URI — le document doit rester autonome et ne jamais dépendre d'un serveur
// tiers qui pourrait tomber ou tracer le lecteur.
const MAX_LOGO = 90_000;
async function logoDe(site) {
  if (!site) return null;
  let base;
  try { base = new URL(/^https?:\/\//i.test(site) ? site : 'https://' + site); } catch (_) { return null; }
  const abs = u => { try { return new URL(u, base).href; } catch (_) { return null; } };
  const tenter = async (url) => {
    if (!url) return null;
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const ct = String(r.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|gif)$/.test(ct)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_LOGO) return null;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch (_) { return null; }
  };
  let html = '';
  try {
    const r = await fetch(base.href, { redirect: 'follow', signal: AbortSignal.timeout(7000) });
    if (r.ok) html = (await r.text()).slice(0, 300000);
  } catch (_) {}
  const cherche = (re) => { const m = html.match(re); return m ? abs(m[1]) : null; };
  const pistes = [
    cherche(/<meta[^>]+property=["']og:logo["'][^>]+content=["']([^"']+)/i),
    cherche(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)/i),
    cherche(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i),
    cherche(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)/i),
    abs('/favicon.ico')
  ];
  for (const u of pistes) { const d = await tenter(u); if (d) return d; }
  return null;
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
2. **Ne promets aucun résultat.** Tu peux montrer ce qu'un autre client a obtenu (cas clients, avec la source) ; tu ne peux pas affirmer que ce prospect obtiendra la même chose. Formule la trajectoire comme un objectif de travail, jamais comme un engagement.
3. **Cite un cas client dans TOUS les cas.** Si aucun n'est du même secteur, dis-le en une phrase et explique pourquoi le levier se transpose quand même. N'écris JAMAIS qu'on n'a rien à montrer : ce serait la pire phrase du document.
4. **Cite le prospect par son nom**, ses vrais chiffres, le vrai nom de son point de vente le plus faible. C'est ce qui prouve qu'on a travaillé pour lui.
5. Français, deuxième personne du pluriel. Direct, concret, sans flatterie, sans jargon, sans point d'exclamation.

════ CE QUE CE DOCUMENT DOIT FAIRE ════
Un directeur marketing va le lire. Il connaît déjà ses problèmes : lui répéter sa note Google ne
vend rien. Ce qui le décide, c'est de comprendre **par quel mécanisme** Sofy change ce chiffre, et
de voir **quelqu'un qui l'a déjà fait**. Le cœur du document, ce sont les "duels" : un problème
mesuré chez lui, en face la brique Sofy qui y répond, et le résultat qu'il peut en attendre.

TROIS INTERDITS — ils ont ruiné les trois versions précédentes de ce document :
· Ne JAMAIS nommer un module sans dire comment il produit le résultat. « SoConnect — messagerie
  unifiée » ne vend rien. « Tous les canaux dans une seule boîte, Budy pré-qualifie, réponse en
  10-15 min au lieu de 30 » vend.
· Ne JAMAIS mettre le contenu dans le titre en laissant les champs vides. Le titre est une
  accroche ; ce sont les champs qui s'affichent à l'écran. Un champ vide = une page blanche
  devant le prospect.
· Ne JAMAIS présenter un déploiement comme un résultat. « 3 outils actifs » n'intéresse personne.
  Ce qui intéresse : la note, le volume d'avis, le délai de réponse, la position concurrentielle.

════ LE FORMULAIRE À REMPLIR ════
Tu ne composes pas la mise en page : tu remplis un formulaire, et le serveur construit le
document. **Tous les champs sont obligatoires.** Quand un champ ne s'applique pas, mets une
chaîne vide "" ou un tableau vide [] — jamais du remplissage.

· titre_document — "Analyse Sofy — <nom du prospect>"
· couverture.titre — le nom du prospect. couverture.texte — qui l'a préparée et à partir de quoi.
· constat.titre — l'accroche du constat (≤65 car.). constat.texte — ≤180 car.
  constat.chiffres — 2 à 4 chiffres MESURÉS chez lui. "valeur" est une chaîne courte ("1,7"),
  "unite" est courte ("★", " %", " avis"), "legende" ≤60 car., "source" dit où on l'a relevé.
· defauts.titre / defauts.texte / defauts.liste — 2 à 4 défauts RELEVÉS sur sa fiche. Reprends les
  éléments de "defauts_fiche" ci-dessus, un par entrée de liste, ≤190 car. chacun. Si
  "defauts_fiche" est absent des mesures, mets liste: [].
· duels — **2 à 4 entrées, c'est le cœur du document.** Chaque entrée :
  · titre — le problème formulé côté conséquence business (≤65 car.)
  · probleme.constat — le fait mesuré (≤120 car.) · probleme.cout — ce que ça lui coûte (≤130 car.)
  · solution.nom — la brique Sofy + ce qu'elle fait (ex : "Soview — collecte d'avis à chaud")
  · solution.comment — **exactement 3 étapes** du mécanisme, ≤90 car. chacune, tirées des blocs
    FONCTIONNALITÉS ci-dessus. C'est la partie qui vend : sois concret et technique.
  · solution.resultat — le résultat visé (≤120 car.), formulé comme un objectif
  · chiffre_cle — un chiffre SOURCÉ de la base qui étaye la solution (résultat d'un cas client ou
    statistique de marché). Si tu n'en as pas de pertinent, mets valeur: "".
  · maquette_rcs — UNIQUEMENT sur le duel qui parle de SMS/RCS, sinon tous les champs vides.
    C'est un exemple de message écrit pour SON métier, avec son bouton (pour un site de ventes
    événementielles : annonce d'une vente en avant-première, bouton "Avant-première").
· trajectoire.titre / .texte (dis que c'est un objectif de travail, pas un engagement)
  · trajectoire.courbe.indicateur — ce qu'on suit (ex : "Note Google moyenne")
  · trajectoire.courbe.unite — "★", " %", " avis"… · .max — le maximum de l'échelle (NOMBRE)
  · trajectoire.courbe.points — 3 ou 4 points. "valeur" est un NOMBRE (1.7, pas "1,7"). Le premier
    point est SA valeur mesurée aujourd'hui. "quand" : "aujourd'hui", "3 mois", "6 mois", "12 mois".
  · trajectoire.courbe.appui — le cas client ou le chiffre sourcé qui rend cette pente défendable.
  · trajectoire.jalons — 3 étapes de déploiement (le bloc des 90 premiers jours).
  Si tu n'as AUCUNE valeur de départ mesurée, mets points: [] — le serveur retirera la planche.
· preuve.titre / .texte (pourquoi ce cas éclaire le sien, secteur différent assumé)
  · preuve.chiffres — 2 à 3 résultats du cas client, avec leur source
  · preuve.citation.texte — le verbatim du client · preuve.citation.meta — qui et où
· cta.titre / cta.texte — ce qu'on fait ensemble au premier rendez-vous · cta.bouton — libellé`;
}

// Le schéma est ce qui garantit la forme. Les trois documents précédents sont sortis avec des
// planches réduites à un titre : le modèle abandonnait les structures imbriquées en cours de
// route. Ici il ne peut plus — l'API refuse une sortie qui ne colle pas au schéma.
const S_TXT = { type: 'string' };
const S_CHIFFRES = {
  type: 'array', items: {
    type: 'object',
    properties: { valeur: S_TXT, unite: S_TXT, legende: S_TXT, source: S_TXT },
    required: ['valeur', 'unite', 'legende', 'source'], additionalProperties: false
  }
};
const SCHEMA = {
  type: 'object',
  properties: {
    titre_document: S_TXT,
    couverture: {
      type: 'object', properties: { titre: S_TXT, texte: S_TXT },
      required: ['titre', 'texte'], additionalProperties: false
    },
    constat: {
      type: 'object', properties: { titre: S_TXT, texte: S_TXT, chiffres: S_CHIFFRES },
      required: ['titre', 'texte', 'chiffres'], additionalProperties: false
    },
    defauts: {
      type: 'object',
      properties: { titre: S_TXT, texte: S_TXT, liste: { type: 'array', items: S_TXT } },
      required: ['titre', 'texte', 'liste'], additionalProperties: false
    },
    duels: {
      type: 'array', items: {
        type: 'object',
        properties: {
          titre: S_TXT,
          probleme: {
            type: 'object', properties: { constat: S_TXT, cout: S_TXT },
            required: ['constat', 'cout'], additionalProperties: false
          },
          solution: {
            type: 'object',
            properties: { nom: S_TXT, comment: { type: 'array', items: S_TXT }, resultat: S_TXT },
            required: ['nom', 'comment', 'resultat'], additionalProperties: false
          },
          chiffre_cle: {
            type: 'object', properties: { valeur: S_TXT, unite: S_TXT, legende: S_TXT, source: S_TXT },
            required: ['valeur', 'unite', 'legende', 'source'], additionalProperties: false
          },
          maquette_rcs: {
            type: 'object', properties: { expediteur: S_TXT, titre: S_TXT, texte: S_TXT, bouton: S_TXT },
            required: ['expediteur', 'titre', 'texte', 'bouton'], additionalProperties: false
          }
        },
        required: ['titre', 'probleme', 'solution', 'chiffre_cle', 'maquette_rcs'],
        additionalProperties: false
      }
    },
    trajectoire: {
      type: 'object',
      properties: {
        titre: S_TXT, texte: S_TXT,
        courbe: {
          type: 'object',
          properties: {
            indicateur: S_TXT, unite: S_TXT, max: { type: 'number' },
            points: {
              type: 'array', items: {
                type: 'object', properties: { quand: S_TXT, valeur: { type: 'number' } },
                required: ['quand', 'valeur'], additionalProperties: false
              }
            },
            appui: S_TXT
          },
          required: ['indicateur', 'unite', 'max', 'points', 'appui'], additionalProperties: false
        },
        jalons: {
          type: 'array', items: {
            type: 'object', properties: { quand: S_TXT, texte: S_TXT },
            required: ['quand', 'texte'], additionalProperties: false
          }
        }
      },
      required: ['titre', 'texte', 'courbe', 'jalons'], additionalProperties: false
    },
    preuve: {
      type: 'object',
      properties: {
        titre: S_TXT, texte: S_TXT, chiffres: S_CHIFFRES,
        citation: {
          type: 'object', properties: { texte: S_TXT, meta: S_TXT },
          required: ['texte', 'meta'], additionalProperties: false
        }
      },
      required: ['titre', 'texte', 'chiffres', 'citation'], additionalProperties: false
    },
    cta: {
      type: 'object', properties: { titre: S_TXT, texte: S_TXT, bouton: S_TXT },
      required: ['titre', 'texte', 'bouton'], additionalProperties: false
    }
  },
  required: ['titre_document', 'couverture', 'constat', 'defauts', 'duels', 'trajectoire', 'preuve', 'cta'],
  additionalProperties: false
};

// Le formulaire rempli devient un document. C'est le SERVEUR qui décide de la mise en page et
// qui écarte ce qui est vide — une planche sans contenu ne peut plus atteindre le prospect,
// quoi que le modèle ait renvoyé.
const plein = v => typeof v === 'string' ? v.trim().length > 0 : !!v;

function assembler(f, mes) {
  const pl = [];
  const nb = (f.duels || []).filter(d => d && plein(d.titre) && d.probleme && d.solution
    && plein(d.probleme.constat) && plein(d.solution.nom)).length;

  pl.push({
    role: 'couverture', eyebrow: 'ANALYSE PRÉPARÉE POUR VOUS',
    titre: (f.couverture && f.couverture.titre) || mes.nom || '',
    texte: (f.couverture && f.couverture.texte) || ''
  });

  const c = f.constat || {};
  if (plein(c.titre) || (c.chiffres || []).length) {
    pl.push({
      role: 'constat', eyebrow: 'CE QUE NOUS AVONS MESURÉ', titre: c.titre, texte: c.texte,
      chiffres: (c.chiffres || []).filter(x => plein(x.valeur)),
      fiche_google: true, avis_reel: true
    });
  }

  const d = f.defauts || {};
  const liste = (d.liste || []).filter(plein);
  if (liste.length) {
    pl.push({ role: 'defauts', eyebrow: "CE QUE VOIT UN CLIENT AVANT D'ACHETER", titre: d.titre, texte: d.texte, defauts: liste });
  }

  (f.duels || []).forEach((x, k) => {
    if (!x || !x.probleme || !x.solution || !plein(x.probleme.constat) || !plein(x.solution.nom)) return;
    const rcs = x.maquette_rcs || {};
    pl.push({
      role: 'duel', eyebrow: `PROBLÈME ${k + 1} SUR ${nb}`, titre: x.titre,
      probleme: { constat: x.probleme.constat, cout: plein(x.probleme.cout) ? x.probleme.cout : null },
      solution: {
        nom: x.solution.nom,
        comment: (x.solution.comment || []).filter(plein),
        resultat: plein(x.solution.resultat) ? x.solution.resultat : null
      },
      chiffre_cle: plein((x.chiffre_cle || {}).valeur) ? x.chiffre_cle : null,
      maquette_rcs: (plein(rcs.titre) || plein(rcs.texte)) ? rcs : null
    });
  });

  const t = f.trajectoire || {};
  const cb = t.courbe || {};
  const pts = (cb.points || []).filter(x => x && typeof x.valeur === 'number' && isFinite(x.valeur));
  const jal = (t.jalons || []).filter(x => x && plein(x.quand) && plein(x.texte));
  if (pts.length > 1 || jal.length) {
    pl.push({
      role: 'trajectoire', eyebrow: 'LA TRAJECTOIRE VISÉE', titre: t.titre, texte: t.texte,
      courbe: pts.length > 1 ? { ...cb, points: pts } : null,
      jalons: jal
    });
  }

  const pv = f.preuve || {};
  const pvc = (pv.chiffres || []).filter(x => plein(x.valeur));
  if (pvc.length || plein((pv.citation || {}).texte)) {
    pl.push({
      role: 'preuve', eyebrow: "ILS L'ONT DÉJÀ FAIT", titre: pv.titre, texte: pv.texte,
      chiffres: pvc, citation: plein((pv.citation || {}).texte) ? pv.citation : null
    });
  }

  const ct = f.cta || {};
  pl.push({ role: 'cta', eyebrow: 'LA SUITE', titre: ct.titre, texte: ct.texte, cta: ct.bouton || 'Réserver 30 minutes' });

  return { titre_document: f.titre_document || `Analyse Sofy — ${mes.nom || ''}`, planches: pl };
}

async function composer(ctx) {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { erreur: 'CLAUDE_API_KEY manquante' };
  const corps = {
    model: MODELE(), max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt(ctx) }]
  };
  const appeler = async (c) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(c)
    });
    return { r, d: await r.json().catch(() => ({})) };
  };
  let { r, d } = await appeler(corps);
  // Repli si le compte ou le modèle n'expose pas encore la sortie contrainte : on repasse en
  // texte libre, avec le même prompt (il décrit déjà la forme attendue mot pour mot).
  if (!r.ok && /output_config|json_schema|format/i.test(JSON.stringify(d.error || ''))) {
    const libre = { ...corps, output_config: { effort: 'high' } };
    ({ r, d } = await appeler(libre));
  }
  if (!r.ok) return { erreur: 'API Claude ' + r.status, detail: (d.error && d.error.message) || JSON.stringify(d).slice(0, 200) };

  const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/```(?:json)?/g, '').trim();
  const a = txt.indexOf('{'), b2 = txt.lastIndexOf('}');
  if (a < 0 || b2 <= a) return { erreur: 'Réponse IA non exploitable', detail: txt.slice(0, 200) };
  let f;
  try { f = JSON.parse(txt.slice(a, b2 + 1)); }
  catch (e) { return { erreur: 'JSON invalide dans la réponse IA', detail: txt.slice(0, 200) }; }
  // Sortie tronquée : le document serait amputé sans qu'on le sache. Mieux vaut le dire.
  if (d.stop_reason === 'max_tokens') return { erreur: 'Rédaction interrompue (trop longue) — relance', detail: 'stop_reason max_tokens' };
  return { ok: true, formulaire: f, usage: d.usage || null };
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
      const rows = await sql`SELECT jeton, client, module, sdr, ouvertures, profondeur, destinataire,
          premiere_ouverture, derniere_ouverture, created_at, expire_le,
          jsonb_array_length(COALESCE(lecteurs,'[]'::jsonb)) AS lecteurs_distincts FROM prez
        WHERE (${['admin', 'superadmin'].includes(user.role)} OR sdr = ${user.nom})
        ORDER BY created_at DESC LIMIT 50`;
      return res.status(200).json({
        ok: true,
        prez: rows.map(r => ({
          ...r, url: BASE_PUB() + '/p/' + r.jeton,
          expiree: r.expire_le ? new Date(r.expire_le).getTime() < Date.now() : false,
          jours_restants: r.expire_le ? Math.ceil((new Date(r.expire_le).getTime() - Date.now()) / 86400000) : null
        }))
      });
    }
    // Les analyses déjà produites sur une liste : le front les affiche dans la fiche, pour que
    // le lien ne vive pas dans une fenêtre qui se ferme.
    if (q.liste_id) {
      const rows = await sql`SELECT jeton, cle_fiche, module, sdr, ouvertures, destinataire,
          premiere_ouverture, derniere_ouverture, created_at, expire_le,
          jsonb_array_length(COALESCE(lecteurs,'[]'::jsonb)) AS lecteurs_distincts
        FROM prez WHERE liste_id = ${parseInt(q.liste_id, 10) || 0} AND cle_fiche IS NOT NULL
        ORDER BY created_at DESC`;
      const parFiche = {};
      for (const r of rows) {
        if (parFiche[r.cle_fiche]) continue; // la plus récente gagne
        parFiche[r.cle_fiche] = {
          ...r, url: BASE_PUB() + '/p/' + r.jeton,
          expiree: r.expire_le ? new Date(r.expire_le).getTime() < Date.now() : false,
          jours_restants: r.expire_le ? Math.ceil((new Date(r.expire_le).getTime() - Date.now()) / 86400000) : null
        };
      }
      return res.status(200).json({ ok: true, par_fiche: parFiche, total: rows.length });
    }
    if (q.jeton) {
      const [row] = await sql`SELECT * FROM prez WHERE jeton = ${String(q.jeton)}`;
      if (!row) return res.status(404).json({ erreur: 'Présentation introuvable' });
      return res.status(200).json({ ok: true, prez: row, url: BASE_PUB() + '/p/' + row.jeton });
    }
    return res.status(400).json({ erreur: 'jeton, liste_id ou mes=1 requis' });
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

    // Base vide au premier usage : on l'amorce nous-mêmes avec le contenu du deck Sofy.
    // Renvoyer « lance POST /api/kb-sales { seed: true } » à un SDR n'était pas une erreur
    // d'affichage, c'était une erreur de conception : l'app sait faire, elle le fait.
    let blocs = await blocsUtilisables(module);
    let amorcage = null;
    if (!blocs.length) {
      try {
        amorcage = await amorcer(user.nom);
        blocs = await blocsUtilisables(module);
      } catch (e) {
        return res.status(500).json({ erreur: "Base de connaissance vide et l'amorçage a échoué",
          detail: String((e && e.message) || e).slice(0, 200) });
      }
    }
    if (!blocs.length) {
      // Si ça arrive encore, le message doit dire POURQUOI plutôt que d'envoyer le SDR au support.
      let diag = '';
      try {
        const [d] = await sql`SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE statut = 'valide')::int AS valides,
            COUNT(*) FILTER (WHERE NOT actif)::int AS inactifs,
            COUNT(*) FILTER (WHERE verifie_le <= CURRENT_DATE - INTERVAL '6 months')::int AS perimes
          FROM kb_sales`;
        diag = `${d.total} bloc(s) en base, ${d.valides} validé(s), ${d.inactifs} désactivé(s), ${d.perimes} périmé(s)`;
      } catch (_) { diag = 'table kb_sales illisible'; }
      return res.status(400).json({
        erreur: 'Aucun bloc utilisable pour ce module',
        detail: diag + (amorcage ? ` · amorçage : ${amorcage.ajoutes} ajouté(s), ${amorcage.remis || 0} remis` : '')
      });
    }

    // Le logo se récupère pendant que Claude rédige : deux attentes en une.
    const [out, logo] = await Promise.all([
      composer({ mes, radar, blocs, module, consigne: b.consigne, sdr: user.nom }),
      logoDe(mes.site_web).catch(() => null)
    ]);
    if (out.erreur) return res.status(502).json(out);

    // Le formulaire rempli devient le document ici, côté serveur : c'est ce qui garantit qu'une
    // planche affichée porte vraiment du contenu.
    out.doc = assembler(out.formulaire, mes);
    const duels = out.doc.planches.filter(p => p.role === 'duel').length;
    if (logo) out.doc._logo = logo;

    const jeton = crypto.randomBytes(9).toString('base64url'); // 12 caractères, non devinable
    const jours = Math.max(1, Math.min(90, parseInt(b.jours_validite || process.env.PREZ_JOURS_VALIDITE || '15', 10) || 15));
    await sql`INSERT INTO prez (jeton, client, module, sdr, liste_id, cle_fiche, destinataire, contenu, expire_le)
      VALUES (${jeton}, ${mes.nom || ''}, ${module}, ${user.nom}, ${b.liste_id ? parseInt(b.liste_id) : null},
              ${b.cle_fiche || null}, ${b.destinataire || null},
              ${JSON.stringify({ ...out.doc, _mes: mes, _sdr: user.nom, _module: module })}::jsonb,
              NOW() + (${jours} || ' days')::interval)`;

    // Trace dans le bloc-notes de la fiche : le lien doit être retrouvable dans l'historique
    // de la relation, à côté des appels et des notes — pas seulement dans l'encart du haut.
    if (b.cle_fiche) {
      try {
        await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
          VALUES (${String(b.cle_fiche).toLowerCase()}, 'prez', 'note',
            ${'🎨 Analyse client générée (' + (NOM_MODULE[module] || module) + ')'},
            ${BASE_PUB() + '/p/' + jeton + ' — lien valable ' + jours + ' jours'},
            ${user.nom}, NOW())`;
      } catch (_) {}
    }
    try { await loggerConso(user, 'ia_claude', 1, b.liste_id || null); } catch (_) {}

    return res.status(200).json({
      ok: true, jeton, url: BASE_PUB() + '/p/' + jeton, client: mes.nom, module, jours_validite: jours,
      amorcage: amorcage && amorcage.ajoutes ? amorcage.ajoutes : undefined,
      planches: (out.doc.planches || []).length,
      duels: duels,
      logo_prospect: !!logo,
      contexte_utilise: { radar: !!radar, blocs_kb: blocs.length, cas_clients: blocs.filter(x => x.type === 'cas_client').length },
      doc: out.doc
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Génération impossible', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
