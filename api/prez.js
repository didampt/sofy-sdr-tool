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
  v.push(crit('Réponses aux avis', 'inconnu', 0, 0, 'non mesurable depuis l\'extérieur — à regarder ensemble'));
  v.push(crit('Fraîcheur et photos', 'inconnu', 0, 0, 'à auditer fiche par fiche au premier rendez-vous'));
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
  r.push(crit('Bouton WhatsApp', wa === null ? 'inconnu' : (wa ? 'ok' : 'faible'), wa ? 20 : 0, 20,
    detail(wa, 'lien WhatsApp détecté sur le site', 'aucun bouton WhatsApp : le canal préféré de vos clients est absent')));
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
  c.push(crit('Dispositif SMS ou RCS identifié', sms === null ? 'inconnu' : (sms ? 'ok' : 'faible'),
    sms ? 50 : 0, 50, sms === null ? 'site non analysé' : (sms ? 'outil détecté' : 'aucun dispositif mobile détecté')));
  c.push(crit('Plateforme de campagnes', mkt === null ? 'inconnu' : (mkt ? 'ok' : 'moyen'),
    mkt ? 30 : 10, 30, mkt === null ? 'site non analysé' : (mkt ? 'plateforme détectée' : 'aucune plateforme détectée')));
  c.push(crit('Expéditeur de marque vérifié', 'inconnu', 0, 0, 'le RCS affiche votre nom et votre logo — à vérifier ensemble'));
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
    bilan_titre: T, bilan_texte: T,
    defauts_titre: T, defauts_texte: T, defauts: { type: 'array', items: T },
    traj_titre: T, traj_texte: T, courbe_indicateur: T, courbe_unite: T, courbe_max: N,
    points: {
      type: 'array',
      items: { type: 'object', properties: { quand: T, valeur: N }, required: ['quand', 'valeur'] }
    },
    courbe_appui: T,
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
    cta_titre: T, cta_texte: T, cta_bouton: T
  },
  required: ['titre_document', 'couv_titre', 'couv_texte', 'constat_titre', 'constat_texte',
    'chiffres', 'bilan_titre', 'bilan_texte', 'defauts_titre', 'defauts_texte', 'defauts', 'traj_titre', 'traj_texte',
    'courbe_indicateur', 'courbe_unite', 'courbe_max', 'points', 'courbe_appui', 'jalons',
    'preuve_titre', 'preuve_texte', 'preuve_chiffres', 'citation', 'citation_meta',
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
· courbe_appui — le cas client ou le chiffre sourcé qui rend cette pente défendable
· jalons — 3 étapes de déploiement, tirées du bloc des 90 premiers jours
· preuve_titre / preuve_texte — pourquoi ce cas client éclaire le sien, secteur différent assumé
· preuve_chiffres — 2 à 3 résultats de ce client, chacun avec sa source
· citation — le verbatim du client · citation_meta — qui l'a dit et où c'est publié
· cta_titre / cta_texte — ce qu'on fait ensemble au premier rendez-vous · cta_bouton — le libellé
  Ne parle PAS de l'ancienneté de Sofy, du nombre de clients, des références ni des agréments :
  la page les affiche elle-même, à l'identique sur toutes les analyses. Concentre-toi sur ce qui
  se passe concrètement au rendez-vous, avec SES données.`;

// Le formulaire rempli devient un document. C'est le SERVEUR qui décide de la mise en page et
// qui écarte ce qui est vide — une planche sans contenu ne peut plus atteindre le prospect,
// quoi que le modèle ait renvoyé.
const plein = v => typeof v === 'string' ? v.trim().length > 0 : !!v;
const chiffresValides = a => (a || []).filter(x => x && plein(x.valeur));

function assembler(cadre, duelsBruts, mes) {
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

  const df = (c.defauts || []).filter(plein);
  if (df.length) {
    pl.push({
      role: 'defauts', eyebrow: "CE QUE VOIT UN CLIENT AVANT D'ACHETER",
      titre: c.defauts_titre, texte: c.defauts_texte, defauts: df
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
        ? { valeur: d.chiffre, unite: d.chiffre_unite, legende: d.chiffre_legende, source: d.chiffre_source }
        : null,
      maquette_rcs: (plein(d.rcs_titre) || plein(d.rcs_texte))
        ? { expediteur: mes.nom || '', titre: d.rcs_titre, texte: d.rcs_texte, bouton: d.rcs_bouton }
        : null,
      visuel_id: (parseInt(d.visuel_id, 10) || 0) || null
    });
  });

  const pts = (c.points || []).filter(x => x && typeof x.valeur === 'number' && isFinite(x.valeur));
  const jal = (c.jalons || []).filter(x => x && plein(x.quand) && plein(x.texte));
  if (pts.length > 1 || jal.length) {
    pl.push({
      role: 'trajectoire', eyebrow: 'LA TRAJECTOIRE VISÉE',
      titre: c.traj_titre, texte: c.traj_texte,
      courbe: pts.length > 1 ? {
        indicateur: c.courbe_indicateur, unite: c.courbe_unite,
        max: c.courbe_max, points: pts, appui: c.courbe_appui
      } : null,
      jalons: jal
    });
  }

  const pvc = chiffresValides(c.preuve_chiffres);
  if (pvc.length || plein(c.citation)) {
    pl.push({
      role: 'preuve', eyebrow: "ILS L'ONT DÉJÀ FAIT",
      titre: c.preuve_titre, texte: c.preuve_texte, chiffres: pvc,
      citation: plein(c.citation) ? { texte: c.citation, meta: c.citation_meta } : null
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
  constat:     [['titre', 65], ['texte', 200], ['chiffres[].legende', 60]],
  defauts:     [['titre', 65], ['texte', 200], ['defauts[]', 190]],
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
  trajectoire: ['le point de départ de la courbe — c\'est la valeur mesurée aujourd\'hui'],
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
          liste_id, cle_fiche, premiere_ouverture, derniere_ouverture, created_at, expire_le,
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
    out.doc = assembler(out.cadre, out.duels, mes);
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
