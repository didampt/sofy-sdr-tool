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
import { visuelsUtilisables, imagesDe } from './kb-visuels.js';
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
  // Horodatage de la dernière alerte Slack : sert à ne pas répéter le même signal (retour du
  // 20/08 — « j'ai reçu plusieurs alertes pour les ouvertures successives du même lien »).
  await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS derniere_alerte TIMESTAMPTZ`;
  // Destinataires NOMMÉS : un lien par personne (/p/<jeton>?d=<n>). C'est la seule façon
  // honnête de répondre à « qui a ouvert ? » — le lien n'oblige personne à s'identifier, donc
  // on ne peut le savoir que si chacun a reçu SON lien.
  await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS destinataires JSONB DEFAULT '[]'::jsonb`;
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
        ? Math.round((g.concurrents.note_moyenne - g.note_moyenne) * 10) / 10 : null,
      // Relevé dédié (l'API Google n'expose pas les réponses du propriétaire) : c'est l'argument
      // Soview le plus direct, il doit arriver jusqu'à la rédaction.
      visibilite_ia: g.ia_visibilite ? {
        requete_testee: g.ia_visibilite.requete,
        apercu_ia_affiche: !!g.ia_visibilite.apercu_present,
        prospect_cite: !!g.ia_visibilite.cite,
        rang_de_citation: g.ia_visibilite.rang_citation,
        entreprises_citees_par_lia: g.ia_visibilite.entreprises_citees || null,
        // Qui PAIE pour être devant sur cette requête. Relevé dans le même appel que l'aperçu IA.
        concurrents_qui_paient: (g.ia_visibilite.annonceurs || []).map(a => ({
          nom: a.nom, note: a.note, avis: a.avis, google_garanti: !!a.garanti, type: a.type
        })),
        nb_annonces: g.ia_visibilite.nb_annonces || 0
      } : null,
      // Apple Plans : la moitié du parc mobile français. Le NAP le promettait, on le mesure.
      apple_plans: g.apple ? {
        present: !!g.apple.present, position: g.apple.position,
        note: g.apple.note, avis: g.apple.avis, categorie: g.apple.categorie,
        site_declare: g.apple.site_declare, telephone_declare: g.apple.telephone_declare,
        trois_premiers: g.apple.trois_premiers || null, total_resultats: g.apple.total_resultats
      } : null,
      audit_fiche: g.audit ? {
        photos: g.audit.photos_total, photos_publiees_par_lenseigne: g.audit.photos_enseigne,
        description: !!g.audit.description_presente, horaires: !!g.audit.horaires_presents,
        position_locale: g.audit.position_locale, requete_testee: g.audit.requete,
        trois_premiers: g.audit.concurrents || null,
        // Le bouton WhatsApp de la fiche Google : l'argument SoConnect le plus direct, et il est
        // MESURÉ. Il ne remontait pas jusqu'ici — la mesure existait sans jamais servir le document.
        categorie_google: g.audit.categorie || null,
        bouton_whatsapp_actif: !!(g.audit.whatsapp_sur_fiche
          || (g.ia_visibilite && g.ia_visibilite.whatsapp_google)),
        whatsapp_ou: g.audit.whatsapp_champ || null
      } : null,
      // Quand la note est inerte (gros volume d'avis), le titre de la planche « trajectoire » doit
      // parler du FLUX et des réponses, jamais d'une note qui remonte.
      note_inerte: (() => {
        const n0 = Number(g.total_avis), a0 = Number(g.note_moyenne);
        if (!isFinite(n0) || !isFinite(a0) || n0 <= 0) return null;
        const r = (g.reponses && Number(g.reponses.rythme_par_mois)) || null;
        const pm = r ? r * 2 : 2.3 * Math.max(1, Number(g.nb_fiches) || 1);
        const N = Math.round(pm * 12);
        return ((a0 * n0 + 4.7 * N) / (n0 + N)) - a0 < 0.25;
      })(),
      reponses_aux_avis: g.reponses ? {
        avis_analyses: g.reponses.analyses,
        avis_avec_reponse: g.reponses.repondus,
        taux_de_reponse_pct: g.reponses.taux,
        delai_median_heures: g.reponses.delai_median_h,
        delai_max_heures: g.reponses.delai_max_h,
        // Le rythme de collecte du prospect, mesuré sur SES avis : c'est lui qui pilote la courbe.
        rythme_actuel_avis_par_mois: g.reponses.rythme_par_mois != null ? g.reponses.rythme_par_mois : null,
        fenetre_de_mesure_mois: g.reponses.fenetre_mois != null ? g.reponses.fenetre_mois : null,
        lecture: g.reponses.taux === 0
          ? 'aucun des avis récents n\'a reçu de réponse publique'
          : `${g.reponses.taux} % des avis récents ont une réponse publique`
      } : null
    };
  } else m.google = { aucune_fiche_trouvee: true };
  if (e.technos_fait) {
    m.technos = (e.technos || []).map(t => ({ nom: t.nom, categorie: t.cat, concurrent_sofy: !!t.concurrent }));
    if (!m.technos.length) m.technos = 'aucun outil détecté sur le site';
  }
  const sc = scorer(e); if (sc) m.scoring = sc;
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
    if (g.ia_visibilite && g.ia_visibilite.apercu_present && !g.ia_visibilite.cite) {
      const iv = g.ia_visibilite;
      const autres = (iv.entreprises_citees || []).slice(0, 3).join(', ');
      d.push(`Sur « ${iv.requete} », l'aperçu IA de Google ne vous cite pas${autres ? ` — il renvoie vers ${autres}` : ''}. Vos futurs clients posent déjà la question à une IA, et la réponse ne vous mentionne pas.`);
    }
    if (g.audit) {
      const a2 = g.audit;
      if (a2.bouton_whatsapp_actif) {
        d.push('Votre fiche Google propose WhatsApp : vos clients vous écrivent déjà, sur un mobile — '
          + 'sans historique partagé, sans transfert possible, et sans trace de ce qui a été promis.');
      }
      if (a2.requete && a2.position_locale == null) {
        d.push(`Sur « ${a2.requete} », votre fiche n'apparaît pas dans les résultats locaux : un client qui cherche le service, et non votre nom, ne vous voit pas.`);
      } else if (a2.position_locale && a2.position_locale > 3 && (a2.concurrents || []).length) {
        const c1 = a2.concurrents[0];
        d.push(`Sur « ${a2.requete} », vous êtes ${a2.position_locale}ᵉ : ${c1.nom}${c1.note ? ` (${String(c1.note).replace('.', ',')}★)` : ''} occupe la première place.`);
      }
      if ((a2.photos_total || 0) < 8) {
        d.push(`${a2.photos_total || 0} photo(s) sur la fiche : un client qui hésite n'a presque rien à regarder avant de vous choisir.`);
      }
    }
    if (g.reponses && typeof g.reponses.taux === 'number') {
      const r = g.reponses;
      if (r.taux === 0) {
        d.push(`Aucun des ${r.analyses} avis les plus récents n'a reçu de réponse publique : chaque client mécontent reste seul à s'exprimer sur votre fiche.`);
      } else if (r.taux < 50) {
        d.push(`${r.repondus} des ${r.analyses} avis récents seulement ont une réponse (${r.taux} %) : plus d'un client sur deux écrit sans obtenir de réponse.`);
      }
      if (r.delai_median_h != null && r.delai_median_h > 168) {
        d.push(`Le délai médian de réponse est de ${Math.round(r.delai_median_h / 24)} jours, quand 63 % des consommateurs l'attendent sous 2 à 7 jours.`);
      }
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
const MAX_PHOTO = 320_000;

// Récupère la première image exploitable parmi une liste de pistes, en data URI.
async function premiereImage(pistes, maxOctets) {
  for (const url of pistes) {
    if (!url) continue;
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'fr-FR,fr;q=0.9' } });
      if (!r.ok) continue;
      const ct = String(r.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|gif|avif)$/.test(ct)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > maxOctets) continue;
      // Une image de 2 Ko en bannière est une icône déguisée : on la refuse pour la photo.
      if (maxOctets === MAX_PHOTO && buf.length < 12000) continue;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch (_) { }
  }
  return null;
}

// Le logo ET une photo d'ambiance, en une seule lecture de la page d'accueil.
async function marqueDe(site) {
  if (!site) return { logo: null, photo: null };
  let base;
  try { base = new URL(/^https?:\/\//i.test(site) ? site : 'https://' + site); } catch (_) { return { logo: null, photo: null }; }
  const abs = u => { try { return new URL(u, base).href; } catch (_) { return null; } };
  let html = '';
  try {
    const r = await fetch(base.href, { redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'fr-FR,fr;q=0.9' } });
    if (r.ok) html = (await r.text()).slice(0, 400000);
  } catch (_) { }
  const meta = (prop) => {
    const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)', 'i');
    const m = html.match(re); return m ? abs(m[1]) : null;
  };
  const lien = (rel) => {
    const re = new RegExp('<link[^>]+rel=["\'][^"\']*' + rel + '[^"\']*["\'][^>]+href=["\']([^"\']+)', 'i');
    const m = html.match(re); return m ? abs(m[1]) : null;
  };
  // Repli quand le site ne déclare pas d'og:image : les images de la page, en écartant celles
  // qui sont manifestement des icônes, des pixels de tracking ou des logos.
  const imagesPage = () => {
    const out = [];
    const re = /<img\b[^>]*?(?:data-src|data-original|srcset|src)=["']([^"']+)/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 14) {
      let u = m[1].split(/[?\s,]/)[0];
      if (!/\.(jpe?g|png|webp|avif)$/i.test(u)) continue;
      if (/(sprite|icon|favicon|logo|pixel|placeholder|blank|1x1|avatar|flag|badge)/i.test(u)) continue;
      const a = abs(u); if (a && !out.includes(a)) out.push(a);
    }
    return out;
  };

  const [logo, photo] = await Promise.all([
    premiereImage([meta('og:logo'), lien('apple-touch-icon'), lien('icon'), abs('/favicon.ico')], MAX_LOGO),
    premiereImage([meta('og:image'), meta('twitter:image'), meta('og:image:secure_url'), ...imagesPage()], MAX_PHOTO)
  ]);
  return { logo, photo };
}

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

// ── Scoring en trois axes, un par module ──────────────────────────────────────────────────────
// Demande de Didier : « on annonce la couleur de suite et on démontre notre professionnalisme ».
// Chaque axe est noté sur 100 à partir de ce qui est RÉELLEMENT mesuré. Un critère non mesurable
// (taux de réponse aux avis, photos : l'API Places ne les expose pas) n'est pas inventé : il est
// marqué « à vérifier » et devient un sujet de rendez-vous, ce qui est plus honnête et plus utile
// qu'un score bricolé. Le calcul est en JS, jamais délégué à l'IA.
function scorer(e) {
  const g = e.gmb || {};
  if (!g.trouve) return null;
  const fiches = g.fiches || [];
  const nbEtab = e.nb_etablissements || null;
  const technos = (e.technos_fait && Array.isArray(e.technos)) ? e.technos : null;
  const cherche = (re) => technos ? technos.some(t => re.test(String(t.nom) + ' ' + String(t.cat))) : null;

  const crit = (libelle, etat, points, sur, detail) => ({ libelle, etat, points, sur, detail });
  const axes = [];

  // ── Visibilité locale (Soview) ──
  const v = [];
  if (typeof g.note_moyenne === 'number') {
    const n = g.note_moyenne;
    v.push(crit('Note moyenne', n >= 4.2 ? 'ok' : (n >= 3.5 ? 'moyen' : 'faible'),
      Math.max(0, Math.min(25, Math.round((n / 5) * 25))), 25,
      String(n).replace('.', ',') + '/5 sur ' + (g.nb_fiches || 1) + ' fiche(s)'));
  }
  if (typeof g.total_avis === 'number' && fiches.length) {
    const parFiche = Math.round(g.total_avis / fiches.length);
    v.push(crit('Volume d\'avis par établissement', parFiche >= 150 ? 'ok' : (parFiche >= 50 ? 'moyen' : 'faible'),
      parFiche >= 150 ? 20 : (parFiche >= 50 ? 12 : 5), 20, parFiche + ' avis en moyenne'));
  }
  if (nbEtab && fiches.length) {
    const couv = Math.min(1, fiches.length / nbEtab);
    v.push(crit('Couverture du réseau', couv >= 0.9 ? 'ok' : (couv >= 0.5 ? 'moyen' : 'faible'),
      Math.round(couv * 20), 20, fiches.length + ' fiche(s) trouvée(s) pour ' + nbEtab + ' établissement(s) déclaré(s)'));
  }
  v.push(crit('Téléphone sur la fiche', g.telephone ? 'ok' : 'faible', g.telephone ? 10 : 0, 10,
    g.telephone ? 'renseigné' : 'absent — un client qui veut vous joindre repart'));
  v.push(crit('Site web sur la fiche', g.site_declare ? 'ok' : 'faible', g.site_declare ? 10 : 0, 10,
    g.site_declare ? 'renseigné' : 'absent — le trafic Google n\'atterrit nulle part'));
  if (fiches.length > 1) {
    const notes = fiches.filter(f => typeof f.note === 'number').map(f => f.note);
    const ecart = notes.length > 1 ? Math.round((Math.max(...notes) - Math.min(...notes)) * 10) / 10 : 0;
    v.push(crit('Homogénéité entre établissements', ecart <= 0.3 ? 'ok' : (ecart <= 0.8 ? 'moyen' : 'faible'),
      ecart <= 0.3 ? 15 : (ecart <= 0.8 ? 8 : 3), 15,
      ecart ? String(ecart).replace('.', ',') + ' point d\'écart entre vos fiches' : 'notes alignées'));
  }
  // Réponses aux avis : mesuré quand le relevé SerpApi a été lancé sur la fiche (l'API Google
  // n'expose pas les réponses du propriétaire). Sinon le critère reste franchement « non mesuré ».
  const rep = g.reponses || null;
  if (rep && typeof rep.taux === 'number') {
    const t = rep.taux;
    v.push(crit('Réponses aux avis', t >= 80 ? 'ok' : (t >= 40 ? 'moyen' : 'faible'),
      Math.round(t / 100 * 20), 20,
      `${rep.repondus}/${rep.analyses} avis récents ont une réponse publique (${t} %)`));
    if (rep.delai_median_h != null) {
      const h = rep.delai_median_h;
      v.push(crit('Délai de réponse', h <= 48 ? 'ok' : (h <= 168 ? 'moyen' : 'faible'),
        h <= 48 ? 15 : (h <= 168 ? 8 : 3), 15,
        h < 48 ? `${h} h en médiane` : `${Math.round(h / 24)} jours en médiane — 63 % des clients l'attendent sous 2 à 7 jours`));
    }
  } else {
    v.push(crit('Réponses aux avis', 'inconnu', 0, 0, 'non mesuré — l\'API Google ne l\'expose pas, un relevé dédié est nécessaire'));
  }
  // Photos et complétude : mesurés par l'audit SerpApi quand il a été lancé sur la fiche.
  const au = g.audit || null;
  if (au) {
    const ph = au.photos_total || 0;
    v.push(crit('Photos de la fiche', ph >= 20 ? 'ok' : (ph >= 8 ? 'moyen' : 'faible'),
      ph >= 20 ? 12 : (ph >= 8 ? 7 : 2), 12,
      `${ph} photo(s)${au.photos_enseigne === 0 && ph > 0 ? ' — aucune publiée par vous : vos clients seuls racontent votre lieu' : ''}`));
    const complet = (au.description_presente ? 1 : 0) + (au.horaires_presents ? 1 : 0);
    v.push(crit('Complétude de la fiche', complet === 2 ? 'ok' : (complet === 1 ? 'moyen' : 'faible'),
      complet * 6, 12,
      [au.description_presente ? null : 'aucune description', au.horaires_presents ? null : 'aucun horaire']
        .filter(Boolean).join(', ') || 'description et horaires renseignés'));
    if (au.position_locale != null || au.requete) {
      v.push(crit('Position sur les recherches locales',
        au.position_locale == null ? 'faible' : (au.position_locale <= 3 ? 'ok' : (au.position_locale <= 10 ? 'moyen' : 'faible')),
        au.position_locale == null ? 0 : (au.position_locale <= 3 ? 18 : (au.position_locale <= 10 ? 9 : 3)), 18,
        au.position_locale == null
          ? `absent des résultats locaux sur « ${au.requete} »`
          : `${au.position_locale}ᵉ sur « ${au.requete} »`));
    }
  } else {
    v.push(crit('Photos et complétude', 'inconnu', 0, 0, 'non mesuré — un audit de fiche dédié est nécessaire'));
  }
  axes.push({ nom: 'Visibilité locale', module: 'Soview', criteres: v });

  // ── Relation client (SoConnect) ──
  const r = [];
  const nomsTechnos = technos ? technos.map(t => t.nom).join(', ') : '';
  const wa = cherche(/whatsapp/i);
  const msgr = cherche(/messenger/i);
  const chatWeb = cherche(/crisp|intercom|zendesk|tawk|tidio|livechat|drift/i);
  const avisOutil = cherche(/avis|review|trustpilot|reput|custeed|garagescore|skeepers/i);
  const detail = (v, oui, non) => v === null ? 'site non analysé' : (v ? oui : non);
  // WhatsApp d'abord : c'est le canal que les clients utilisent spontanément, et son absence est
  // le manque le plus parlant sur un site grand public.
  // DEUX sources depuis le 21/08 : le site (détection de technos) ET la fiche Google, où Google
  // permet de rattacher un numéro WhatsApp. Le score ne change pas de sens — l'avoir vaut mieux
  // que ne pas l'avoir — mais le libellé dit OÙ il est, parce que l'angle de vente n'est pas le
  // même : sur la fiche, le canal existe déjà et c'est ce qu'il y a derrière qui manque.
  const waFiche = !!((au && au.whatsapp_sur_fiche)
    || (g.ia_visibilite && g.ia_visibilite.whatsapp_google));
  const waQqPart = waFiche || wa === true;
  const waEtat = (wa === null && !waFiche) ? 'inconnu' : (waQqPart ? 'ok' : 'faible');
  // Le libellé doit dire CE QUI A ÉTÉ VÉRIFIÉ. « site non analysé » seul laissait croire qu'on
  // n'avait rien regardé, alors que la fiche Google avait bien été contrôlée (retour Didier, 21/08).
  const ficheVue = !!au;
  r.push(crit('Bouton WhatsApp', waEtat, waQqPart ? 20 : 0, 20,
    waFiche && wa === true ? 'WhatsApp sur le site ET sur la fiche Google — le canal est en place, reste à savoir ce qu\'il y a derrière'
    : waFiche ? 'WhatsApp actif sur la fiche Google : vos clients écrivent déjà, sur un mobile, sans historique ni suivi partagé'
    : wa === true ? 'lien WhatsApp détecté sur le site'
    : (wa === null && ficheVue) ? 'aucun WhatsApp sur votre fiche Google (vérifié) — le site, lui, n\'a pas encore été analysé'
    : (wa === null) ? 'site non analysé et fiche non relevée — rien n\'a pu être vérifié'
    : ficheVue ? 'aucun bouton WhatsApp, ni sur le site ni sur votre fiche Google : le canal préféré de vos clients est absent'
    : 'aucun bouton WhatsApp sur le site ; la fiche Google n\'a pas été relevée'));
  r.push(crit('Chat sur le site', chatWeb === null ? 'inconnu' : (chatWeb ? 'ok' : 'faible'), chatWeb ? 20 : 0, 20,
    detail(chatWeb, 'outil de chat détecté', 'aucune messagerie web détectée')));
  r.push(crit('Messenger ou réseaux sociaux', msgr === null ? 'inconnu' : (msgr ? 'ok' : 'moyen'), msgr ? 10 : 0, 10,
    detail(msgr, 'plugin Messenger détecté', 'aucun canal social branché sur le site')));
  r.push(crit('Outil de collecte ou de réponse aux avis', avisOutil === null ? 'inconnu' : (avisOutil ? 'ok' : 'faible'),
    avisOutil ? 25 : 0, 25, detail(avisOutil, 'outil détecté : ' + nomsTechnos.slice(0, 60), 'aucun outil détecté : la réputation subit')));
  r.push(crit('Joignabilité téléphonique affichée', g.telephone ? 'ok' : 'faible', g.telephone ? 25 : 0, 25,
    g.telephone ? 'numéro public sur la fiche' : 'aucun numéro sur la fiche'));
  r.push(crit('Délai de première réponse', 'inconnu', 0, 0, 'non mesurable depuis l\'extérieur — à chronométrer ensemble'));
  axes.push({ nom: 'Relation client', module: 'SoConnect', criteres: r });

  // ── Communication mobile (SoReach) ──
  const c = [];
  // Brevo, Mailjet et Mailchimp sont détectés par leurs FORMULAIRES email : les compter comme
  // dispositif mobile donnait 100/100 en communication mobile à un prospect qui n'envoie aucun
  // SMS — et détruisait l'argument SoReach. Seuls les outils réellement SMS/RCS comptent ici.
  const sms = cherche(/\bsms\b|\brcs\b|twilio|attentive|smsmode|esendex|smsfactor|octopush|vonage/i);
  const mkt = cherche(/brevo|sendinblue|mailjet|mailchimp|klaviyo|salesforce|emarsys|braze|actito|selligent|hubspot/i);
  const nomsMkt = technos ? technos.filter(t => /marketing|sms|rcs/i.test(String(t.cat))).map(t => t.nom).join(', ') : '';
  c.push(crit('Outil d\'envoi SMS ou RCS sur le site', sms === null ? 'inconnu' : (sms ? 'ok' : 'faible'),
    sms ? 45 : 0, 45,
    sms === null ? 'site non analysé'
      : (sms ? 'balise d\'un outil SMS/RCS trouvée sur vos pages'
             : 'aucune balise d\'outil SMS ou RCS sur vos pages — nous ne voyons donc pas de dispositif mobile en place')));
  c.push(crit('Plateforme de communication client', mkt === null ? 'inconnu' : (mkt ? 'ok' : 'faible'),
    mkt ? 35 : 0, 35,
    mkt === null ? 'site non analysé'
      : (mkt ? `${nomsMkt.slice(0, 60)} détecté${/,/.test(nomsMkt) ? 's' : ''} : le budget relation client existe déjà`
             : 'aucune plateforme détectée : les envois, s\'il y en a, ne passent par aucun outil visible')));
  // Ce qui n'est PAS mesurable depuis l'extérieur, dit franchement : un agent RCS de marque
  // n'est pas déclaré publiquement, et un historique de campagnes ne se lit pas sur un site.
  c.push(crit('Campagnes déjà envoyées', 'inconnu', 0, 0,
    'invisible depuis l\'extérieur — seul votre historique d\'envois le dit'));
  c.push(crit('Agent RCS de marque déclaré', 'inconnu', 0, 0,
    'les agents RCS ne figurent dans aucun annuaire public — à vérifier avec vos opérateurs'));
  axes.push({ nom: 'Communication mobile', module: 'SoReach', criteres: c });

  axes.forEach(a => {
    const notes = a.criteres.filter(x => x.sur > 0);
    const obtenus = notes.reduce((s2, x) => s2 + x.points, 0);
    const total = notes.reduce((s2, x) => s2 + x.sur, 0);
    a.score = total ? Math.round((obtenus / total) * 100) : null;
    a.verdict = a.score == null ? 'non évalué' : (a.score >= 70 ? 'solide' : (a.score >= 45 ? 'à renforcer' : 'critique'));
  });

  return {
    etablissements: nbEtab, fiches_trouvees: fiches.length,
    note_moyenne: g.note_moyenne, total_avis: g.total_avis,
    site_analyse: !!technos, axes
  };
}

function prompt({ mes, radar, blocs, module, consigne, sdr, visuels }) {
  const parType = t => blocs.filter(b => b.type === t)
    .map(b => `• ${b.id ? `[#${b.id}] ` : ''}${b.titre}${b.secteur ? ` [secteur : ${b.secteur}]` : ''}${b.territoire ? ` [territoire : ${b.territoire}]` : ''}\n  ${b.contenu}\n  SOURCE : ${b.source || 'interne'}`).join('\n');
  return `Tu rédiges une présentation commerciale personnalisée pour **un prospect précis**, au nom de **Sofy** (éditeur français : Soview = avis Google et visibilité locale · SoConnect = messagerie clients unifiée avec IA Budy · SoReach = campagnes SMS et RCS).

Module mis en avant : **${NOM_MODULE[module] || module}**. Commercial signataire : ${sdr || 'l\'équipe Sofy'}.
${consigne ? `\nCONSIGNE DU COMMERCIAL (prioritaire) : ${consigne}\n` : ''}
════ CE QUE NOUS AVONS MESURÉ CHEZ CE PROSPECT (données réelles, utilisables librement) ════
SECTEUR DU PROSPECT : ${mes.activite || mes.secteur_rb2b || '(non renseigné)'}${mes.google && mes.google.audit_fiche && mes.google.audit_fiche.categorie_google ? ` · catégorie Google : ${mes.google.audit_fiche.categorie_google}` : ''}
(c'est ce secteur qui doit guider le choix du cas client — voir la consigne plus bas)
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

${(visuels || []).length ? `════ VISUELS DISPONIBLES (choisis par leur identifiant) ════
${visuels.slice(0, 25).map(v => `#${v.id} [${v.type}${v.secteur ? ' · ' + v.secteur : ''}] ${v.description}`).join('\n')}
` : ''}
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

════ CE QU'ON TE DEMANDE ════
Tu ne composes pas la mise en page : tu remplis un formulaire, et le serveur construit le
document. **Tous les champs sont obligatoires.** Quand un champ ne s'applique pas, mets une
chaîne vide "" ou un tableau vide [] — jamais du remplissage.
`;
}

// ── Deux formulaires courts plutôt qu'un gros ────────────────────────────────────────────────
// Un seul schéma couvrant tout le document faisait tomber l'API en 400 : « the compiled grammar
// is too large ». Les deux moitiés sont indépendantes (elles partent des mêmes données), donc
// elles se remplissent en parallèle : deux grammaires modestes, et pas une seconde de plus.
const T = { type: 'string' };
const N = { type: 'number' };

// Moitié 1 — le cœur : un problème mesuré, la brique Sofy en face, le résultat visé.
const SCHEMA_DUELS = {
  type: 'object',
  properties: {
    duels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titre: T, probleme: T, cout: T,
          solution: T, etapes: { type: 'array', items: T }, resultat: T,
          chiffre: T, chiffre_unite: T, chiffre_legende: T, chiffre_source: T,
          rcs_titre: T, rcs_texte: T, rcs_bouton: T, visuel_id: { type: 'number' }
        },
        required: ['titre', 'probleme', 'cout', 'solution', 'etapes', 'resultat',
          'chiffre', 'chiffre_unite', 'chiffre_legende', 'chiffre_source',
          'rcs_titre', 'rcs_texte', 'rcs_bouton', 'visuel_id']
      }
    }
  },
  required: ['duels']
};

// Moitié 2 — le décor : constat, défauts, trajectoire, preuve, conclusion.
const SCHEMA_CADRE = {
  type: 'object',
  properties: {
    titre_document: T, couv_titre: T, couv_texte: T,
    constat_titre: T, constat_texte: T,
    chiffres: {
      type: 'array',
      items: {
        type: 'object',
        properties: { valeur: T, unite: T, legende: T, source: T },
        required: ['valeur', 'unite', 'legende', 'source']
      }
    },
    bilan_titre: T, bilan_texte: T, marche_titre: T, marche_texte: T,
    defauts_titre: T, defauts_texte: T, defauts: { type: 'array', items: T },
    traj_titre: T, traj_texte: T, courbe_indicateur: T, courbe_unite: T, courbe_max: N,
    points: {
      type: 'array',
      items: { type: 'object', properties: { quand: T, valeur: N }, required: ['quand', 'valeur'] }
    },
    courbe_appui: T,
    courbe2_indicateur: T, courbe2_unite: T, courbe2_max: N,
    points2: {
      type: 'array',
      items: { type: 'object', properties: { quand: T, valeur: N }, required: ['quand', 'valeur'] }
    },
    jalons: {
      type: 'array',
      items: { type: 'object', properties: { quand: T, texte: T }, required: ['quand', 'texte'] }
    },
    preuve_titre: T, preuve_texte: T,
    preuve_chiffres: {
      type: 'array',
      items: {
        type: 'object',
        properties: { valeur: T, unite: T, legende: T, source: T },
        required: ['valeur', 'unite', 'legende', 'source']
      }
    },
    citation: T, citation_meta: T,
    preuve_cas_id: N,
    cta_titre: T, cta_texte: T, cta_bouton: T
  },
  required: ['titre_document', 'couv_titre', 'couv_texte', 'constat_titre', 'constat_texte',
    'chiffres', 'bilan_titre', 'bilan_texte', 'marche_titre', 'marche_texte', 'defauts_titre', 'defauts_texte', 'defauts', 'traj_titre', 'traj_texte',
    'courbe_indicateur', 'courbe_unite', 'courbe_max', 'points', 'courbe_appui', 'jalons',
    'courbe2_indicateur', 'courbe2_unite', 'courbe2_max', 'points2',
    'preuve_titre', 'preuve_texte', 'preuve_chiffres', 'citation', 'citation_meta', 'preuve_cas_id',
    'cta_titre', 'cta_texte', 'cta_bouton']
};

const CONSIGNE_DUELS = `
Remplis "duels" avec **2 à 4 entrées**. C'est le cœur du document : un problème mesuré chez lui,
en face la brique Sofy qui y répond, et le résultat qu'il peut en attendre.

Pour chaque duel :
· titre — le problème formulé côté conséquence business, ≤65 caractères
· probleme — le fait mesuré chez lui, ≤120 car. · cout — ce que ça lui coûte concrètement, ≤130 car.
· solution — la brique Sofy ET ce qu'elle fait (ex : "Soview — collecte d'avis à chaud par SMS")
· etapes — **exactement 3 étapes** du mécanisme, ≤90 car. chacune, tirées des blocs
  FONCTIONNALITÉS ci-dessus. C'est la partie qui vend : sois concret et technique. Interdit de
  reformuler le nom du module ; on veut le mécanisme.
· resultat — le résultat visé, ≤120 car., formulé comme un objectif et non comme une promesse
· chiffre / chiffre_unite / chiffre_legende / chiffre_source — un chiffre SOURCÉ de la base qui
  étaye cette solution (résultat d'un cas client, statistique de marché). Si tu n'en as pas de
  pertinent pour CE duel, mets les quatre champs à "".
· rcs_titre / rcs_texte / rcs_bouton — UNIQUEMENT sur le duel qui parle de SMS ou de RCS, sinon
  les trois à "". C'est un exemple de message écrit pour SON métier, avec son bouton : pour un
  site de ventes événementielles, l'annonce d'une vente en avant-première, bouton "Avant-première".
  rcs_titre ≤42 car., rcs_texte ≤150 car., rcs_bouton ≤22 car.`;

const CONSIGNE_CADRE = `
Remplis le cadre du document — tout sauf les duels, qui sont rédigés à part.

· titre_document — "Analyse Sofy — <nom du prospect>"
· couv_titre — le nom du prospect · couv_texte — qui l'a préparée et à partir de quoi
· constat_titre ≤65 car. · constat_texte ≤180 car.
· chiffres — 2 à 4 chiffres MESURÉS chez lui. "valeur" est une chaîne courte ("1,7"), "unite" est
  courte ("★", " %", " avis"), "legende" ≤60 car., "source" dit où on l'a relevé.
· marche_titre ≤65 car. / marche_texte ≤180 car. — la planche POSITION LOCALE. La page affiche
  elle-même le rang, les trois premiers concurrents, les concurrents qui PAIENT (Google Ads),
  la présence sur Apple Plans et la citation par l'IA de Google : commente
  ce que ça veut dire pour lui, ne recopie pas les chiffres. Si "audit_fiche" et "visibilite_ia"
  sont absents des mesures, laisse ces deux champs vides.
· bilan_titre ≤65 car. / bilan_texte ≤180 car. — la planche du SCORING. Les trois scores sur 100
  et leur détail sont affichés par la page, tu n'as pas à les écrire : commente ce qu'ils
  révèlent (l'axe le plus faible, ce que ça dit du réseau) et dis franchement que les critères
  non mesurables à distance seront audités ensemble.
· defauts_titre / defauts_texte / defauts — 2 à 4 défauts RELEVÉS sur sa fiche. Reprends les
  éléments de "defauts_fiche" des mesures, un par entrée, ≤190 car. chacun. Si "defauts_fiche"
  est absent des mesures, mets defauts: [].
· traj_titre / traj_texte — la trajectoire visée. Dis dans traj_texte que c'est un objectif de
  travail et non un engagement contractuel.
· courbe_indicateur — ce qu'on suit (ex : "Note Google moyenne") · courbe_unite ("★", " %")
· courbe_max — le maximum de l'échelle, un NOMBRE (5 pour une note sur 5)
· points — 3 ou 4 points. "valeur" est un NOMBRE (1.7, jamais "1,7"). Le premier point est SA
  valeur mesurée aujourd'hui ("quand": "aujourd'hui"), puis "3 mois", "6 mois", "12 mois".
  Si tu n'as AUCUNE valeur de départ mesurée, mets points: [].
· ⚠️ Les DEUX COURBES (note et volume d'avis) sont CALCULÉES par le serveur à partir des valeurs
  mesurées : n'écris AUCUN chiffre de trajectoire, ni dans traj_texte, ni ailleurs. Pas de
  « 4,2★ dans 12 mois », pas de « 350 avis ». Deux analyses du même client doivent afficher la
  même prévision ; c'est le calcul qui la garantit, pas toi. Laisse points, points2, courbe_max
  et courbe2_* vides.
· ⚠️ Si google.note_inerte est vrai, la note NE PEUT PAS être l'objectif : avec ce volume d'avis
  accumulés, elle bougerait de moins d'un quart de point en un an. N'écris donc AUCUNE promesse de
  remontée de note dans traj_titre ni traj_texte. Le sujet devient : ce qu'un client lit avant de
  choisir, ce sont les derniers avis et les réponses publiques. Le serveur affichera les courbes
  « avis traités » et « avis collectés par mois » — écris le titre qui va avec.
· traj_texte — explique le MÉCANISME, pas les chiffres : pourquoi le volume d'avis récents tire
  la note, et ce que le prospect doit mettre en place pour que ça arrive.
· courbe_appui — le cas client ou le chiffre sourcé qui rend cette pente défendable
· jalons — 3 étapes de déploiement, tirées du bloc des 90 premiers jours
· preuve_titre / preuve_texte — pourquoi ce cas client éclaire le sien, secteur différent assumé
· preuve_chiffres — 2 à 3 résultats de ce client, chacun avec sa source
· citation — le verbatim du client · citation_meta — qui l'a dit et où c'est publié
· Si audit_fiche.bouton_whatsapp_actif est vrai, c'est l'argument SoConnect le plus direct qui
  existe et il doit servir : ce prospect envoie DÉJÀ ses clients sur WhatsApp depuis sa fiche
  Google. Le problème n'est pas le canal, c'est ce qu'il y a derrière — un mobile personnel, sans
  historique partagé, sans transfert entre collègues, sans reprise quand la personne est absente,
  et rien de mesurable. Formule-le comme un constat, jamais comme un reproche : il a fait le bon
  choix de canal. S'il est faux, N'EN PARLE PAS : l'absence de bouton ne prouve rien.
· ⚠️ CHOIX DU CAS CLIENT — le secteur passe avant tout le reste. Les blocs portent leur secteur
  entre crochets. Le prospect est du secteur indiqué dans « activite » des mesures : prends le cas
  client du MÊME métier s'il existe, même si un autre cas a de plus beaux chiffres. Un garagiste
  qui lit le cas d'un distributeur de pièces auto se reconnaît ; le même garagiste qui lit le cas
  d'un réseau télécom se demande ce qu'il fait là. Ne choisis un cas d'un autre secteur que si
  AUCUN cas du métier du prospect n'est disponible — et dis alors explicitement pourquoi le
  mécanisme se transpose.
· preuve_cas_id — le NUMÉRO [#n] du cas client dont tu t'es servi, tel qu'il figure dans la base
  ci-dessus. Il sert au serveur à poser le bon lien « Lire l'interview ». Mets 0 si tu n'as
  utilisé aucun cas client nommé. N'écris JAMAIS d'adresse web toi-même.
· cta_titre / cta_texte — ce qu'on fait ensemble au premier rendez-vous · cta_bouton — le libellé
  Ne parle PAS de l'ancienneté de Sofy, du nombre de clients, des références ni des agréments :
  la page les affiche elle-même, à l'identique sur toutes les analyses. Concentre-toi sur ce qui
  se passe concrètement au rendez-vous, avec SES données.`;

// Le formulaire rempli devient un document. C'est le SERVEUR qui décide de la mise en page et
// qui écarte ce qui est vide — une planche sans contenu ne peut plus atteindre le prospect,
// quoi que le modèle ait renvoyé.
const plein = v => typeof v === 'string' ? v.trim().length > 0 : !!v;
// Un nombre écrit par un modèle arrive parfois avec la queue du binaire : « 3,400000000000 »
// s'est affiché tel quel sur la planche Marimax du 20/08. On le remet en forme AVANT de
// l'enregistrer : deux décimales au maximum, zéros de fin coupés, virgule française.
const nettoyerNombre = (v) => {
  const t = String(v == null ? '' : v).trim();
  // Un « chiffre » peut être « 85,7 % », « x2 », « +30 % » : on ne touche qu'au nombre lui-même.
  return t.replace(/-?\d+[.,]\d{3,}/g, (m) => {
    const n = Number(m.replace(',', '.'));
    if (!isFinite(n)) return m;
    return String(Math.round(n * 100) / 100).replace('.', ',');
  });
};

// ── La trajectoire : calculée, jamais rédigée ────────────────────────────────────────────────
// Deux analyses du MÊME client donnaient deux prévisions différentes (AGS le 20/08 : 4,2★ et
// 350 avis dans un cas, 4,0★ et 330 dans l'autre). Un chiffre qui change d'un tir à l'autre n'est
// pas une prévision, c'est une invention — et il est indéfendable en rendez-vous. Le calcul est
// donc fait ici, à partir des seules valeurs mesurées, avec des hypothèses écrites en clair sur
// la planche. Même prospect, même trajectoire, à la virgule près.
//
// Le modèle est ARITHMÉTIQUE et volontairement prudent : la note affichée est traitée comme la
// moyenne des avis existants, et chaque avis sollicité entre dans cette moyenne. Google pondère
// en réalité la fraîcheur — la vraie remontée est donc plus rapide que cette courbe, qui est un
// plancher, pas une promesse.
//
// LE RYTHME DE COLLECTE — la question posée par Didier le 21/08.
// Une constante unique était le mauvais réglage : elle rendait la courbe plate chez un prospect
// à gros volume d'avis et exagérée chez un petit. Le rythme visé est donc construit sur SES
// chiffres, dans cet ordre :
//   1. son rythme ACTUEL, mesuré sur les dates de ses propres avis récents (avis-reponses.js) ;
//   2. l'effet de la sollicitation : on vise le DOUBLE de ce rythme. Sofy ne crée pas de clients,
//      il demande l'avis à tous au lieu d'attendre les spontanés — la mécanique est mesurée
//      (campagne SoReach : 85,7 % d'ouverture, 47,1 % de clic) ;
//   3. un plancher : le rythme observé chez un client Soview (Groupe Kiosque, 436 avis en 6 mois
//      sur 32 points de vente = 2,3 avis/mois/établissement). Il évite une courbe morte quand le
//      prospect ne collecte quasiment rien aujourd'hui.
// Les deux facteurs sont réglables par variable d'environnement, sans toucher au code.
const AVIS_MOIS_PAR_FICHE = parseFloat(process.env.PREZ_AVIS_MOIS_PAR_FICHE || '2.3');
const FACTEUR_SOLLICITATION = parseFloat(process.env.PREZ_FACTEUR_SOLLICITATION || '2');
const NOTE_AVIS_SOLLICITE = parseFloat(process.env.PREZ_NOTE_AVIS_SOLLICITE || '4.7');
const JALONS_TRAJ = [[0, "aujourd'hui"], [3, '3 mois'], [6, '6 mois'], [12, '12 mois']];
// Sous ce gain sur 12 mois, la note est INERTE et n'est plus le bon objectif à montrer.
// Constat NORAUTO du 21/08 : 2 899 avis, 3,3★ — même en doublant la collecte, +0,13 point en un an,
// et 65 mois pour gagner un demi-point. La courbe était juste et invendable, ce qui est le pire des
// deux mondes. Quand la moyenne ne peut pas bouger, on montre ce qui bouge VRAIMENT et on dit
// pourquoi : ce qu'un client lit, ce sont les derniers avis et les réponses, pas la moyenne.
const SEUIL_INERTIE = parseFloat(process.env.PREZ_SEUIL_INERTIE || '0.25');

function trajectoire(mes) {
  const g = (mes && mes.google) || {};
  const n0 = Number(g.total_avis), a0 = Number(g.note_moyenne);
  if (!isFinite(n0) || !isFinite(a0) || n0 <= 0 || a0 <= 0) return null;
  const fiches = Math.max(1, Number(g.nb_fiches) || 1);
  const plancher = AVIS_MOIS_PAR_FICHE * fiches;
  const actuel = (g.reponses_aux_avis && Number(g.reponses_aux_avis.rythme_actuel_avis_par_mois)) || null;
  // Le rythme visé. Quand le sien est mesuré, on le DOUBLE et on s'arrête là : mélanger sa mesure
  // avec un plancher par fiche donnait 73 avis/mois sur un réseau de 32 fiches qui en collecte 12
  // — un chiffre que personne ne pourrait défendre. Le plancher ne sert donc qu'à combler
  // l'absence de mesure.
  const parMois = (actuel && isFinite(actuel)) ? actuel * FACTEUR_SOLLICITATION : plancher;
  const notes = [], volumes = [];
  for (const [m, lib] of JALONS_TRAJ) {
    const nouveaux = Math.round(parMois * m);
    const note = (a0 * n0 + NOTE_AVIS_SOLLICITE * nouveaux) / (n0 + nouveaux);
    notes.push({ quand: lib, valeur: Math.round(Math.min(5, note) * 10) / 10 });
    volumes.push({ quand: lib, valeur: n0 + nouveaux });
  }
  const finale = notes[notes.length - 1].valeur;
  const gain = Math.round((finale - a0) * 100) / 100;

  // ── Cas de la note inerte : on change d'indicateur, pas de discours ──
  if (gain < SEUIL_INERTIE) {
    const rep = (g.reponses_aux_avis && Number(g.reponses_aux_avis.taux_de_reponse_pct));
    const taux0 = isFinite(rep) ? rep : null;
    // Le CUMUL d'avis récents, pas le rythme : un rythme plafonne dès le 3ᵉ mois et donne une
    // courbe plate, qui ne montre rien. Le cumul monte, et c'est lui qui parle — « 298 avis
    // récents collectés en 12 mois » se voit et se défend.
    const flux = JALONS_TRAJ.map(([m, lib]) => ({ quand: lib, valeur: Math.round(parMois * m) }));
    const reponses = taux0 == null ? null : JALONS_TRAJ.map(([m, lib]) => ({
      quand: lib, valeur: m === 0 ? taux0 : Math.min(100, Math.round(taux0 + (100 - taux0) * (m / 6)))
    }));
    return {
      note_inerte: true, gain_note_12_mois: gain,
      notes: reponses || flux, volumes: reponses ? flux : volumes,
      indicateur1: reponses ? 'Avis traités' : 'Avis récents collectés',
      unite1: reponses ? ' %' : ' avis', max1: reponses ? 100 : null,
      indicateur2: reponses ? 'Avis récents collectés' : 'Nombre total d\'avis',
      unite2: ' avis', max2: null,
      par_mois: Math.round(parMois * 10) / 10,
      hypothese: `Votre note ne peut PAS être l'objectif : avec ${n0} avis accumulés, elle ne gagnerait `
        + `que ${String(gain).replace('.', ',')} point en 12 mois même en doublant la collecte — il faudrait plus de `
        + `cinq ans pour un demi-point. C'est de l'arithmétique, pas un manque d'ambition. `
        + `Ce qu'un client lit avant de choisir, ce sont les DERNIERS avis et vos réponses : c'est là que ça se joue, `
        + `et c'est ce que cette courbe suit.`,
      resume: taux0 != null
        ? `${taux0} % → 100 % d'avis traités, et ${Math.round(parMois * 12)} avis récents collectés en 12 mois.`
        : `${Math.round(parMois * 12)} avis récents collectés en 12 mois, contre ${Math.round((actuel || plancher) * 12)} au rythme actuel.`
    };
  }

  return {
    notes, volumes, par_mois: Math.round(parMois * 10) / 10, note_inerte: false,
    indicateur1: 'Note Google' + ((g.nb_fiches > 1) ? ' moyenne du réseau' : ''),
    unite1: '★', max1: 5, indicateur2: 'Nombre total d\'avis', unite2: ' avis', max2: null,
    hypothese: `Calcul arithmétique sur vos ${n0} avis actuels (${String(a0).replace('.', ',')}★). `
      + (actuel
        ? `Vous collectez aujourd'hui ${String(Math.round(actuel * 10) / 10).replace('.', ',')} avis par mois — mesuré sur les dates de vos avis récents. `
          + `La courbe vise ${String(Math.round(parMois * 10) / 10).replace('.', ',')} par mois : `
          + (parMois > actuel * FACTEUR_SOLLICITATION - 0.01 && parMois < actuel * FACTEUR_SOLLICITATION + 0.01
            ? `le double, obtenu en demandant l'avis à tous vos clients au lieu d'attendre les spontanés. `
            : `le rythme observé chez un client Soview équipé (Groupe Kiosque : 436 avis en 6 mois sur 32 points de vente). `)
        : `Faute de dates exploitables sur vos avis, la courbe applique le rythme observé chez un client Soview équipé `
          + `(Groupe Kiosque : 436 avis en 6 mois sur 32 points de vente${fiches > 1 ? `, appliqué à vos ${fiches} fiches` : ''}), `
          + `soit ${String(Math.round(parMois * 10) / 10).replace('.', ',')} avis par mois. `)
      + `Nouveaux avis comptés à ${String(NOTE_AVIS_SOLLICITE).replace('.', ',')}/5 en moyenne. `
      + `Google pondère la fraîcheur des avis : cette courbe est donc un plancher, pas une promesse.`,
    resume: `${String(a0).replace('.', ',')}★ → ${String(finale).replace('.', ',')}★ en 12 mois, `
      + `et ${n0} → ${volumes[volumes.length - 1].valeur} avis.`
  };
}

const chiffresValides = a => (a || []).filter(x => x && plein(x.valeur))
  .map(x => ({ ...x, valeur: nettoyerNombre(x.valeur) }));

function assembler(cadre, duelsBruts, mes, blocs) {
  const c = cadre || {};
  const pl = [];

  pl.push({
    role: 'couverture', eyebrow: 'ANALYSE PRÉPARÉE POUR VOUS',
    titre: plein(c.couv_titre) ? c.couv_titre : (mes.nom || ''),
    texte: c.couv_texte || ''
  });

  // Bilan chiffré juste après la couverture : le prospect voit où il en est sur les trois axes
  // avant même qu'on lui parle de nous. C'est ce qui « annonce la couleur » (demande Didier).
  if (mes.scoring && (mes.scoring.axes || []).length) {
    pl.push({
      role: 'bilan', eyebrow: 'OÙ VOUS EN ÊTES AUJOURD\'HUI',
      titre: plein(c.bilan_titre) ? c.bilan_titre : 'Votre réseau, noté sur trois axes',
      texte: plein(c.bilan_texte) ? c.bilan_texte
        : 'Relevé depuis l\'extérieur, comme le ferait un client. Ce qui n\'est pas mesurable à distance est signalé plutôt que supposé.',
      scoring: mes.scoring
    });
  }

  const ch = chiffresValides(c.chiffres);
  if (ch.length || plein(c.constat_titre)) {
    pl.push({
      role: 'constat', eyebrow: 'CE QUE NOUS AVONS MESURÉ',
      titre: c.constat_titre, texte: c.constat_texte, chiffres: ch,
      fiche_google: true, avis_reel: true
    });
  }

  // Planche « position sur le marché local » : construite par le serveur à partir des relevés.
  // C'est l'Analyse marché de Soview, mesurée — Didier la juge l'argument le plus fort.
  const au0 = (mes.google && mes.google.audit_fiche) || null;
  const iv0 = (mes.google && mes.google.visibilite_ia) || null;
  // Garde-fou : pas de planche sans matière. Une requête testée qui n'a rendu ni podium, ni
  // position, ni aperçu IA ne donnerait qu'un titre au-dessus du vide — le défaut que Didier a
  // signalé trois fois.
  const ap0 = (mes.google && mes.google.apple_plans) || null;
  const mkOk = ((au0 && (au0.position_locale != null || (au0.trois_premiers || []).length))
    || (iv0 && (iv0.apercu_ia_affiche || (iv0.concurrents_qui_paient || []).length))
    || (ap0 && ap0.total_resultats));
  if (mkOk && ((au0 && au0.requete_testee) || (iv0 && iv0.requete_testee))) {
    pl.push({
      role: 'marche', eyebrow: 'CE QUE TROUVE UN CLIENT QUI VOUS CHERCHE',
      titre: plein(c.marche_titre) ? c.marche_titre : 'Votre position quand on cherche le service',
      texte: plein(c.marche_texte) ? c.marche_texte
        : 'Relevé sur la requête qu\'un client tape pour trouver votre métier, sans connaître votre nom.',
      marche: {
        requete: (au0 && au0.requete_testee) || (iv0 && iv0.requete_testee),
        position: au0 ? au0.position_locale : null,
        concurrents: (au0 && au0.trois_premiers) || null,
        ia: iv0 || null,
        // Trois façons d'arriver devant le prospect : le référencement, l'achat d'espace, et
        // l'autre carte (Apple). Les trois sont mesurées, aucune n'est affirmée.
        ads: (iv0 && (iv0.concurrents_qui_paient || []).length) ? iv0.concurrents_qui_paient.slice(0, 5) : null,
        apple: ap0 || null
      }
    });
  }

  const df = (c.defauts || []).filter(plein);
  if (df.length) {
    pl.push({
      role: 'defauts', eyebrow: "CE QUE VOIT UN CLIENT AVANT D'ACHETER",
      titre: c.defauts_titre, texte: c.defauts_texte, defauts: df,
      // Par défaut : la cascade de ses fiches Google (la preuve). Le commercial peut y substituer
      // une image de la bibliothèque depuis l'éditeur.
      visuel_id: null
    });
  }

  const duels = (duelsBruts || []).filter(d => d && plein(d.probleme) && plein(d.solution));
  duels.forEach((d, k) => {
    pl.push({
      role: 'duel', eyebrow: `PROBLÈME ${k + 1} SUR ${duels.length}`,
      titre: plein(d.titre) ? d.titre : d.probleme,
      probleme: { constat: d.probleme, cout: plein(d.cout) ? d.cout : null },
      solution: {
        nom: d.solution,
        comment: (d.etapes || []).filter(plein),
        resultat: plein(d.resultat) ? d.resultat : null
      },
      chiffre_cle: plein(d.chiffre)
        ? { valeur: nettoyerNombre(d.chiffre), unite: d.chiffre_unite, legende: d.chiffre_legende, source: d.chiffre_source }
        : null,
      maquette_rcs: (plein(d.rcs_titre) || plein(d.rcs_texte))
        ? { expediteur: mes.nom || '', titre: d.rcs_titre, texte: d.rcs_texte, bouton: d.rcs_bouton }
        : null,
      visuel_id: (parseInt(d.visuel_id, 10) || 0) || null
    });
  });

  // Les points ne viennent PLUS de la rédaction : ils sont calculés (cf. trajectoire()).
  const tr = trajectoire(mes);
  const jal = (c.jalons || []).filter(x => x && plein(x.quand) && plein(x.texte));
  if (tr || jal.length) {
    pl.push({
      role: 'trajectoire', eyebrow: 'LA TRAJECTOIRE VISÉE',
      titre: c.traj_titre, texte: c.traj_texte,
      // Les indicateurs viennent du calcul, pas d'ici : quand la note est inerte, trajectoire()
      // renvoie « avis traités » et « avis collectés par mois » à sa place.
      courbe: tr ? {
        indicateur: tr.indicateur1, unite: tr.unite1,
        max: tr.max1 || Math.ceil(Math.max(...tr.notes.map(x => x.valeur)) * 1.2),
        points: tr.notes,
        appui: plein(c.courbe_appui) ? c.courbe_appui : null,
        hypothese: tr.hypothese
      } : null,
      courbe2: tr ? {
        indicateur: tr.indicateur2, unite: tr.unite2,
        max: tr.max2 || Math.ceil(Math.max(...tr.volumes.map(x => x.valeur)) * 1.15),
        points: tr.volumes
      } : null,
      jalons: jal
    });
  }

  const pvc = chiffresValides(c.preuve_chiffres);
  if (pvc.length || plein(c.citation)) {
    // « Lire l'interview » : le lien vient de la BASE, pas de la rédaction. L'IA a seulement
    // désigné le cas client par son numéro ; c'est le serveur qui va chercher l'URL enregistrée.
    // Une adresse écrite par un modèle dans un document signé Sofy est indéfendable.
    const casId = parseInt(c.preuve_cas_id, 10) || 0;
    const bloc = casId ? (blocs || []).find(b => b.id === casId && b.lien) : null;
    pl.push({
      role: 'preuve', eyebrow: "ILS L'ONT DÉJÀ FAIT",
      titre: c.preuve_titre, texte: c.preuve_texte, chiffres: pvc,
      citation: plein(c.citation) ? { texte: c.citation, meta: c.citation_meta } : null,
      lien: bloc ? { url: bloc.lien, libelle: /interview|entretien|t.moignage/i.test(bloc.titre || '') ? 'Lire l\'interview' : 'Lire le cas client' } : null
    });
  }

  pl.push({
    role: 'cta', eyebrow: 'LA SUITE', titre: c.cta_titre, texte: c.cta_texte,
    cta: plein(c.cta_bouton) ? c.cta_bouton : 'Réserver 30 minutes'
  });

  return {
    titre_document: plein(c.titre_document) ? c.titre_document : `Analyse Sofy — ${mes.nom || ''}`,
    planches: pl
  };
}

// ── L'éditeur ─────────────────────────────────────────────────────────────────────────────────
// Décision prise avec Didier : les textes sont libres, les VALEURS MESURÉES sont verrouillées.
// Si l'on peut taper « 4,2 » à la main sur un prospect relevé à 1,7, on a construit une machine
// à produire des documents faux signés Sofy. Cette table est la seule autorité sur ce qui est
// modifiable ; elle est renvoyée au front, qui construit son formulaire à partir d'elle. Rien
// d'autre n'est écrit, quel que soit le contenu de la requête.
const CHAMPS = {
  couverture:  [['titre', 65], ['texte', 200]],
  bilan:       [['titre', 65], ['texte', 200]],
  marche:      [['titre', 65], ['texte', 200]],
  constat:     [['titre', 65], ['texte', 200], ['chiffres[].legende', 60]],
  defauts:     [['titre', 65], ['texte', 200], ['defauts[]', 190], ['visuel_id', 0]],
  duel:        [['titre', 65], ['probleme.constat', 120], ['probleme.cout', 130],
                ['solution.nom', 90], ['solution.comment[]', 90], ['solution.resultat', 120],
                ['chiffre_cle.legende', 80], ['visuel_id', 0],
                ['maquette_rcs.titre', 42], ['maquette_rcs.texte', 150], ['maquette_rcs.bouton', 22]],
  trajectoire: [['titre', 65], ['texte', 200], ['courbe.appui', 220],
                ['jalons[].quand', 32], ['jalons[].texte', 110]],
  preuve:      [['titre', 65], ['texte', 200]],
  cta:         [['titre', 65], ['texte', 200], ['cta', 40]]
};
// Ce que l'éditeur montre en lecture seule, avec la raison : le SDR doit comprendre pourquoi
// c'est verrouillé, sinon il croit à un bug.
const VERROUS = {
  constat: ['les valeurs et sources des chiffres — elles viennent du relevé'],
  bilan: ['les trois scores et leurs critères — ils sont calculés, pas rédigés'],
  duel: ['la valeur du chiffre d\'appui et sa source — elles viennent de la base de connaissance'],
  trajectoire: ['les deux courbes : leur point de départ est la valeur mesurée aujourd\'hui'],
  marche: ['le podium, la position et la citation par l\'IA — relevés sur la requête testée'],
  preuve: ['les résultats du cas client et le verbatim — ils viennent de la base']
};

const tronquer = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Applique une valeur sur un chemin ('solution.comment[]', 'probleme.cout') dans la planche
// stockée, en partant TOUJOURS de l'existant : un champ absent de la requête reste inchangé.
function appliquer(cible, source, chemin, max) {
  // Un identifiant de visuel est un nombre, pas du texte : on le valide comme tel.
  if (max === 0) {
    if (source && source[chemin] !== undefined) {
      const n = parseInt(source[chemin], 10);
      cible[chemin] = (n > 0) ? n : null;
    }
    return;
  }
  const tab = chemin.includes('[]');
  const [avant, apres] = chemin.split('[]');
  const parts = avant.split('.').filter(Boolean);
  const feuille = apres ? apres.replace(/^\./, '') : null;

  let refC = cible, refS = source;
  for (let i = 0; i < parts.length - (tab ? 0 : 1); i++) {
    refC = refC && refC[parts[i]]; refS = refS && refS[parts[i]];
    if (!refC) return;
  }
  if (!tab) {
    const cle = parts[parts.length - 1];
    if (refS && typeof refS[cle] === 'string') refC[cle] = tronquer(refS[cle], max);
    return;
  }
  // Cas tableau : on garde la longueur du tableau stocké, on n'écrase que les textes.
  if (!Array.isArray(refC) || !Array.isArray(refS)) return;
  refC.forEach((el, i) => {
    const src = refS[i];
    if (src == null) return;
    if (feuille) { if (el && typeof src[feuille] === 'string') el[feuille] = tronquer(src[feuille], max); }
    else if (typeof src === 'string') refC[i] = tronquer(src, max);
  });
}

// Reconstruit le document à partir du stocké + des modifications autorisées, dans l'ordre
// demandé, en retirant les planches supprimées.
function fusionner(stocke, recu) {
  const src = Array.isArray(recu && recu.planches) ? recu.planches : [];
  const parId = new Map();
  (stocke.planches || []).forEach((pl, i) => parId.set(i, pl));

  const sortie = [];
  const vues = new Set();
  for (const p of src) {
    const i = parseInt(p && p.i, 10);
    if (!parId.has(i) || vues.has(i)) continue;      // index inconnu ou dupliqué : ignoré
    if (p.supprimee) { vues.add(i); continue; }
    const base = JSON.parse(JSON.stringify(parId.get(i)));
    for (const [chemin, max] of (CHAMPS[base.role] || [])) appliquer(base, p, chemin, max);
    sortie.push(base); vues.add(i);
  }
  // Une planche non mentionnée n'est pas perdue : elle reste à sa place relative.
  (stocke.planches || []).forEach((pl, i) => { if (!vues.has(i)) sortie.push(pl); });

  // Un document sans couverture ni conclusion n'a pas de sens : on refuse de tout supprimer.
  if (!sortie.length) return null;
  return { ...stocke, planches: sortie };
}

// Un appel = un formulaire court. Le mode utilisé est remonté : si la sortie contrainte est
// refusée par l'API, on veut le savoir plutôt que de découvrir un document dégradé.
async function remplir(apiKey, base, consigne, schema) {
  const corps = {
    model: MODELE(), max_tokens: 20000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: base + consigne }]
  };
  const envoyer = async (c) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(c)
    });
    return { r, d: await r.json().catch(() => ({})) };
  };
  let mode = 'schema';
  let { r, d } = await envoyer(corps);
  if (!r.ok && /grammar|output_config|json_schema|format/i.test(JSON.stringify(d.error || ''))) {
    mode = 'libre';
    const libre = { ...corps, output_config: { effort: 'high' } };
    ({ r, d } = await envoyer({
      ...libre,
      messages: [{ role: 'user', content: base + consigne + '\n\nRéponds UNIQUEMENT par un objet JSON conforme aux champs décrits, sans texte autour et sans backticks.' }]
    }));
  }
  if (!r.ok) return { erreur: 'API Claude ' + r.status, detail: (d.error && d.error.message) || JSON.stringify(d).slice(0, 200) };
  if (d.stop_reason === 'max_tokens') return { erreur: 'Rédaction interrompue (trop longue) — relance' };
  const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/```(?:json)?/g, '').trim();
  const a = txt.indexOf('{'), b2 = txt.lastIndexOf('}');
  if (a < 0 || b2 <= a) return { erreur: 'Réponse IA non exploitable', detail: txt.slice(0, 160) };
  try { return { ok: true, mode, data: JSON.parse(txt.slice(a, b2 + 1)), usage: d.usage || null }; }
  catch (_) { return { erreur: 'JSON invalide dans la réponse IA', detail: txt.slice(0, 160) }; }
}

async function composer(ctx) {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { erreur: 'CLAUDE_API_KEY manquante' };
  const base = prompt(ctx);
  // En parallèle : les deux moitiés partent des mêmes données, elles ne s'attendent pas.
  let [cadre, duels] = await Promise.all([
    remplir(apiKey, base, CONSIGNE_CADRE, SCHEMA_CADRE),
    remplir(apiKey, base, CONSIGNE_DUELS, SCHEMA_DUELS)
  ]);
  // Le cadre porte la couverture et la conclusion : sans lui, il n'y a pas de document.
  if (cadre.erreur) return cadre;
  // Les duels sont le cœur du document : un document sans eux n'est qu'un audit. On réessaie
  // une fois plutôt que de livrer une analyse qui ne propose rien.
  if (duels.erreur || !((duels.data || {}).duels || []).length) {
    duels = await remplir(apiKey, base, CONSIGNE_DUELS, SCHEMA_DUELS);
  }
  const cout = [cadre, duels].filter(x => x && x.usage)
    .reduce((s, x) => s + ((x.usage.input_tokens || 0) * 5 + (x.usage.output_tokens || 0) * 25) / 1e6, 0);
  return {
    ok: true, cadre: cadre.data, duels: (duels.ok && duels.data.duels) || [],
    mode: [cadre.mode, duels.ok ? duels.mode : 'échec'].join('+'),
    duels_erreur: duels.erreur || null,
    cout_eur: Math.round(cout * 100) / 100
  };
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
          destinataires, liste_id, cle_fiche, premiere_ouverture, derniere_ouverture, created_at, expire_le,
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
          destinataires, premiere_ouverture, derniere_ouverture, created_at, expire_le,
          jsonb_array_length(COALESCE(lecteurs,'[]'::jsonb)) AS lecteurs_distincts
        FROM prez WHERE liste_id = ${parseInt(q.liste_id, 10) || 0} AND cle_fiche IS NOT NULL
        ORDER BY created_at DESC`;
      // TOUTES les analyses d'une fiche, pas seulement la dernière : un même prospect peut avoir
      // une version générique et une version SoConnect, et le SDR choisit celle qu'il envoie
      // (demande Didier 20/08). `par_fiche` garde la plus récente pour compatibilité ; la liste
      // complète part dans `toutes_par_fiche`.
      const parFiche = {}, toutes = {};
      for (const r of rows) {
        const enrichi = {
          ...r, url: BASE_PUB() + '/p/' + r.jeton,
          expiree: r.expire_le ? new Date(r.expire_le).getTime() < Date.now() : false,
          jours_restants: r.expire_le ? Math.ceil((new Date(r.expire_le).getTime() - Date.now()) / 86400000) : null
        };
        if (!parFiche[r.cle_fiche]) parFiche[r.cle_fiche] = enrichi;   // la plus récente
        (toutes[r.cle_fiche] = toutes[r.cle_fiche] || []).push(enrichi);
      }
      return res.status(200).json({ ok: true, par_fiche: parFiche, toutes_par_fiche: toutes, total: rows.length });
    }
    if (q.jeton) {
      const [row] = await sql`SELECT * FROM prez WHERE jeton = ${String(q.jeton)}`;
      if (!row) return res.status(404).json({ erreur: 'Présentation introuvable' });
      if (q.edit === '1') {
        const admin = ['admin', 'superadmin'].includes(user.role);
        if (!admin && row.sdr !== user.nom) {
          return res.status(403).json({ erreur: 'Tu ne peux modifier que tes propres analyses.' });
        }
        const doc = row.contenu || {};
        return res.status(200).json({
          ok: true, jeton: row.jeton, client: row.client, module: row.module,
          url: BASE_PUB() + '/p/' + row.jeton,
          ouvertures: row.ouvertures, lecteurs: (row.lecteurs || []).length,
          modifie_le: row.modifie_le || null, modifie_par: row.modifie_par || null,
          annulable: !!row.contenu_precedent,
          planches: (doc.planches || []).map((pl, i) => ({ ...pl, i })),
          champs: CHAMPS, verrous: VERROUS,
          visuels: await visuelsUtilisables({ module: row.module }).catch(() => []),
          // Les chiffres citables, pour changer un chiffre d'appui sans jamais le saisir à la main
          appuis: (doc._appuis || null)
        });
      }
      return res.status(200).json({ ok: true, prez: row, url: BASE_PUB() + '/p/' + row.jeton });
    }
    return res.status(400).json({ erreur: 'jeton, liste_id ou mes=1 requis' });
  }

  // ── Destinataires : on inscrit les personnes choisies et on rend À CHACUNE son lien ──
  // POST { action:'destinataires', jeton, contacts:[{nom,email,tel,canal}] }
  //   → [{ n, nom, email, tel, url }]  (url = /p/<jeton>?d=<n>)
  // POST { action:'envoye', jeton, n, canal }  → note la date et le canal d'envoi
  if (req.method === 'POST' && ['destinataires', 'envoye'].includes(String((req.body || {}).action || ''))) {
    const b3 = req.body || {};
    const j3 = String(b3.jeton || '').slice(0, 40);
    const [row3] = await sql`SELECT jeton, sdr, destinataires, expire_le FROM prez WHERE jeton = ${j3}`;
    if (!row3) return res.status(404).json({ erreur: 'Analyse introuvable' });
    const admin3 = ['admin', 'superadmin'].includes(user.role);
    if (!admin3 && row3.sdr !== user.nom) return res.status(403).json({ erreur: 'Cette analyse n\'est pas la tienne.' });
    let dest = Array.isArray(row3.destinataires) ? row3.destinataires.slice() : [];

    if (b3.action === 'envoye') {
      const n = parseInt(b3.n, 10);
      if (!dest[n]) return res.status(400).json({ erreur: 'destinataire inconnu' });
      dest[n] = { ...dest[n], envoye_le: new Date().toISOString(), canal: String(b3.canal || '').slice(0, 20) };
      await sql`UPDATE prez SET destinataires = ${JSON.stringify(dest)}::jsonb WHERE jeton = ${j3}`;
      return res.status(200).json({ ok: true, destinataires: dest });
    }

    const cts = Array.isArray(b3.contacts) ? b3.contacts.slice(0, 8) : [];
    if (!cts.length) return res.status(400).json({ erreur: 'Choisis au moins un destinataire' });
    const cle = x => String((x.email || x.tel || x.nom || '')).toLowerCase().replace(/\s/g, '');
    const sortie = [];
    for (const c of cts) {
      const nom = String(c.nom || '').slice(0, 80);
      const email = c.email ? String(c.email).toLowerCase().slice(0, 160) : null;
      const tel = c.tel ? String(c.tel).slice(0, 24) : null;
      if (!email && !tel) continue;
      // Un destinataire déjà inscrit garde SON lien : sinon on casserait le suivi de ses lectures.
      let n = dest.findIndex(d => cle(d) === cle({ email, tel, nom }));
      if (n < 0) { dest.push({ nom, email, tel, ajoute_le: new Date().toISOString(), ouvertures: 0 }); n = dest.length - 1; }
      else dest[n] = { ...dest[n], nom: nom || dest[n].nom, email: email || dest[n].email, tel: tel || dest[n].tel };
      sortie.push({ n, nom, email, tel, url: BASE_PUB() + '/p/' + j3 + '?d=' + n });
    }
    if (!sortie.length) return res.status(400).json({ erreur: 'Aucun destinataire exploitable (ni email ni mobile)' });
    await sql`UPDATE prez SET destinataires = ${JSON.stringify(dest)}::jsonb WHERE jeton = ${j3}`;
    return res.status(200).json({ ok: true, destinataires: sortie,
      expiree: !!(row3.expire_le && new Date(row3.expire_le) < new Date()) });
  }

  // Publication des modifications : on republie sur le MÊME jeton — le prospect qui a déjà le
  // lien voit la nouvelle version, et on ne repaye aucune rédaction.
  if (req.method === 'PUT') {
    const b2 = req.body || {};
    const j = String(b2.jeton || '');
    if (!j) return res.status(400).json({ erreur: 'jeton requis' });
    const [row] = await sql`SELECT * FROM prez WHERE jeton = ${j}`;
    if (!row) return res.status(404).json({ erreur: 'Analyse introuvable' });
    const admin = ['admin', 'superadmin'].includes(user.role);
    if (!admin && row.sdr !== user.nom) {
      return res.status(403).json({ erreur: 'Tu ne peux modifier que tes propres analyses.' });
    }
    try { await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS contenu_precedent JSONB`; } catch (_) {}
    try { await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS modifie_le TIMESTAMPTZ`; } catch (_) {}
    try { await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS modifie_par TEXT`; } catch (_) {}

    // Retour en arrière : une seule version conservée, c'est suffisant pour rattraper une bourde.
    if (b2.annuler) {
      if (!row.contenu_precedent) return res.status(400).json({ erreur: 'Aucune version précédente à restaurer' });
      await sql`UPDATE prez SET contenu = contenu_precedent, contenu_precedent = NULL,
        modifie_le = NOW(), modifie_par = ${user.nom} WHERE jeton = ${j}`;
      return res.status(200).json({ ok: true, info: 'Version précédente restaurée.' });
    }

    const fusion = fusionner(row.contenu || {}, b2);
    if (!fusion) return res.status(400).json({ erreur: 'Le document ne peut pas être vide' });
    await sql`UPDATE prez SET contenu_precedent = contenu, contenu = ${JSON.stringify(fusion)}::jsonb,
      modifie_le = NOW(), modifie_par = ${user.nom} WHERE jeton = ${j}`;
    return res.status(200).json({
      ok: true, planches: fusion.planches.length,
      url: BASE_PUB() + '/p/' + j,
      info: `Modifications publiées sur le même lien${row.ouvertures ? ` — le prospect l'avait déjà ouvert ${row.ouvertures} fois` : ''}.`
    });
  }

  // Suppression manuelle : un document parti chez le mauvais interlocuteur, ou une version
  // qu'on ne veut plus voir ouverte. Le lien doit mourir immédiatement, pas dans 15 jours.
  if (req.method === 'DELETE') {
    const j = String((req.query || {}).jeton || '');
    if (!j) return res.status(400).json({ erreur: 'jeton requis' });
    const [row] = await sql`SELECT sdr, client FROM prez WHERE jeton = ${j}`;
    if (!row) return res.status(404).json({ erreur: 'Analyse introuvable' });
    if (!['admin', 'superadmin'].includes(user.role) && row.sdr !== user.nom) {
      return res.status(403).json({ erreur: 'Tu ne peux supprimer que tes propres analyses.' });
    }
    await sql`DELETE FROM prez WHERE jeton = ${j}`;
    return res.status(200).json({ ok: true, info: `Analyse ${row.client || ''} supprimée — le lien ne s'ouvre plus.` });
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET, POST, PUT ou DELETE' });
  const b = req.body || {};
  // « generique » est le mot du tag d'angle côté fiche ; « tous » celui de la base de
  // connaissance. Les deux désignent la même chose : couvrir les trois volets.
  const modBrut = String(b.module || '') === 'generique' ? 'tous' : String(b.module || '');
  const module = ['soview', 'soconnect', 'soreach', 'tous'].includes(modBrut) ? modBrut : 'tous';

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
    const visuels = await visuelsUtilisables({ module, secteur: mes.activite || mes.secteur_rb2b || '' })
      .catch(() => []);
    const [out, marque] = await Promise.all([
      composer({ mes, radar, blocs, module, consigne: b.consigne, sdr: user.nom, visuels }),
      marqueDe(mes.site_web).catch(() => ({ logo: null, photo: null }))
    ]);
    const logo = marque.logo;
    if (out.erreur) return res.status(502).json(out);

    // Le formulaire rempli devient le document ici, côté serveur : c'est ce qui garantit qu'une
    // planche affichée porte vraiment du contenu.
    out.doc = assembler(out.cadre, out.duels, mes, blocs);
    // Un document sans planche « problème → réponse Sofy » ne vend rien : autant le dire au SDR
    // plutôt que de lui laisser envoyer un audit.
    if (!out.doc.planches.some(p => p.role === 'duel')) {
      return res.status(502).json({
        erreur: 'Les planches « problème → solution Sofy » n\'ont pas pu être rédigées',
        detail: (out.duels_erreur || 'la rédaction est revenue vide') + ' — relance : c\'est le cœur du document, mieux vaut ne rien envoyer sans elles.'
      });
    }
    // Mémorisés pour l'éditeur : changer un chiffre d'appui se fait en le CHOISISSANT, jamais
    // en le tapant — c'est ce qui garantit qu'un chiffre publié a toujours sa source.
    out.doc._appuis = blocs.filter(x => ['chiffre_marche', 'cas_client', 'preuve'].includes(x.type))
      .slice(0, 40).map(x => ({ titre: x.titre, source: x.source || 'interne' }));
    const duels = out.doc.planches.filter(p => p.role === 'duel').length;
    if (logo) out.doc._logo = logo;
    if (marque.photo) out.doc._photo = marque.photo;

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
            ${'🎨 Audit client générée (' + (NOM_MODULE[module] || module) + ')'},
            ${BASE_PUB() + '/p/' + jeton + ' — lien valable ' + jours + ' jours'},
            ${user.nom}, NOW())`;
      } catch (_) {}
    }
    try { await loggerConso(user, 'ia_claude', 1, b.liste_id || null); } catch (_) {}

    return res.status(200).json({
      ok: true, jeton, url: BASE_PUB() + '/p/' + jeton, client: mes.nom, module, jours_validite: jours,
      amorcage: amorcage && amorcage.ajoutes ? amorcage.ajoutes : undefined,
      planches: (out.doc.planches || []).length,
      duels, mode_sortie: out.mode, cout_eur: out.cout_eur,
      visuels_proposes: visuels.length,
      photo_prospect: !!marque.photo,
      visuels_utilises: out.doc.planches.filter(p => p.visuel_id).length,
      duels_erreur: out.duels_erreur || undefined,
      logo_prospect: !!logo,
      contexte_utilise: { radar: !!radar, blocs_kb: blocs.length, cas_clients: blocs.filter(x => x.type === 'cas_client').length },
      doc: out.doc
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Génération impossible', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
