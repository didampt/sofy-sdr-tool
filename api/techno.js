// /api/techno.js — Détection des technologies présentes sur le site d'un prospect (gratuit : 1 fetch).
// POST { site } → { ok, technos:[{id, nom, cat, concurrent}] }
//   cat = 'avis' (outil d'e-réputation — concurrents Soview), 'chat' (messagerie web — angle SoConnect),
//         'marketing' (emailing/CRM — contexte SoReach).
// Usage : appelé par le pipeline 🚀 quand la fiche a un domaine. Signature = sous-chaîne dans le HTML
// de la page d'accueil (les widgets se chargent globalement). Anti-SSRF identique à gmb-liste.js.

import { verifierToken } from './db.js';

export const config = { maxDuration: 15 };

/* ⚠️ INTÉGRATION vs MENTION — le défaut le plus grave relevé le 21/08.
   Un motif était cherché n'importe où dans le HTML, texte compris. Sur sofy.fr — qui VEND contre
   Guest Suite et le nomme dans ses pages comparatives — l'audit annonçait donc « outil détecté :
   Guest Suite » à notre propre sujet. Une page qui parle d'un outil n'en est pas équipée.
   Désormais un motif ne compte comme OUTIL INSTALLÉ que s'il apparaît dans une URL de ressource
   (src=, href=, data-*, une balise link) — c'est ce qui distingue un widget chargé d'un mot écrit.
   Un motif vu ailleurs est rendu comme `mention:true` et ne vaut PAS équipement. */
const SIGNATURES = [
  // Nos propres outils. Ils manquaient — donc un client Sofy était vu comme « terrain vierge »,
  // et l'audit de notre propre fiche concluait qu'on n'avait ni outil d'avis ni dispositif SMS.
  // Conséquence commerciale directe : proposer Soview à un client qui l'a déjà.
  { id: 'sofy', nom: 'Sofy', cat: 'avis', concurrent: false, nous: true,
    motifs: ['soview', 'soconnect', 'soreach', 'widget.sofy', 'cdn.sofy', 'sofy.fr/widget', 'getsofy', 'budy.sofy'] },
  // Outils d'avis / e-réputation — concurrents directs de Soview
  { id: 'partoo', nom: 'Partoo', cat: 'avis', concurrent: true, motifs: ['partoo.co', 'partoo.com', 'widget.partoo'] },
  { id: 'guest-suite', nom: 'Guest Suite', cat: 'avis', concurrent: true, motifs: ['guest-suite.com', 'guestsuite.io', 'guest-suite.io'] },
  { id: 'avis-verifies', nom: 'Avis Vérifiés (Skeepers)', cat: 'avis', concurrent: true, motifs: ['avis-verifies', 'netreviews', 'skeepers.io', 'widget.avis-verifies'] },
  { id: 'trustpilot', nom: 'Trustpilot', cat: 'avis', concurrent: true, motifs: ['widget.trustpilot', 'trustpilot.com/review', 'tp.widget'] },
  { id: 'custeed', nom: 'Custeed / GarageScore', cat: 'avis', concurrent: true, motifs: ['custeed', 'garagescore'] },
  { id: 'opinion-system', nom: 'Opinion System', cat: 'avis', concurrent: true, motifs: ['opinionsystem'] },
  { id: 'trustville', nom: 'Trustville', cat: 'avis', concurrent: true, motifs: ['trustville'] },
  { id: 'avis-garantis', nom: 'Société des Avis Garantis', cat: 'avis', concurrent: true, motifs: ['avis-garantis'] },
  { id: 'eldo', nom: 'Eldo (avis BTP)', cat: 'avis', concurrent: true, motifs: ['eldotravo', 'eldo.com/widget'] },
  // Messagerie / chat web — angle SoConnect (ils gèrent déjà des conversations clients)
  { id: 'crisp', nom: 'Crisp', cat: 'chat', concurrent: true, motifs: ['crisp.chat'] },
  { id: 'tawk', nom: 'Tawk.to', cat: 'chat', concurrent: true, motifs: ['tawk.to'] },
  { id: 'intercom', nom: 'Intercom', cat: 'chat', concurrent: true, motifs: ['widget.intercom.io', 'intercomcdn'] },
  { id: 'zendesk', nom: 'Zendesk Chat', cat: 'chat', concurrent: true, motifs: ['zdassets', 'zopim'] },
  { id: 'tidio', nom: 'Tidio', cat: 'chat', concurrent: true, motifs: ['tidio.co'] },
  { id: 'livechat', nom: 'LiveChat', cat: 'chat', concurrent: true, motifs: ['livechatinc'] },
  { id: 'messenger', nom: 'Messenger (plugin FB)', cat: 'chat', concurrent: false, motifs: ['customerchat', 'xfbml.customer'] },
  // parLien : un bouton WhatsApp ou Messenger EST un <a href>. Exiger un script les rendrait
  // indétectables, alors que c'est leur seule façon d'exister sur un site.
  { id: 'whatsapp', nom: 'WhatsApp (lien/widget)', cat: 'chat', concurrent: false, parLien: true, motifs: ['wa.me/', 'api.whatsapp.com', 'chat.whatsapp.com'] },
  { id: 'messenger-lien', nom: 'Messenger (lien)', cat: 'chat', concurrent: false, parLien: true, motifs: ['m.me/'] },
  // Marketing / emailing — contexte (l'entreprise investit déjà dans la relation client)
  { id: 'brevo', nom: 'Brevo (ex-Sendinblue)', cat: 'marketing', concurrent: true, motifs: ['sendinblue', 'sibforms', 'brevo.com'] },
  { id: 'mailchimp', nom: 'Mailchimp', cat: 'marketing', concurrent: false, motifs: ['mailchimp', 'list-manage.com'] },
  { id: 'hubspot', nom: 'HubSpot', cat: 'marketing', concurrent: false, motifs: ['js.hs-scripts', 'hsforms'] },
  // Vrais outils SMS/RCS. ⚠️ Leur ABSENCE ne prouve rien : une plateforme d'envoi SMS ne laisse
  // aucune trace sur un site web. C'est le scorer qui doit refuser d'en conclure quoi que ce soit.
  { id: 'sofy-sms', nom: 'Sofy SMS/RCS', cat: 'sms', concurrent: false, nous: true, motifs: ['soreach', 'sms.sofy', 'ur9.fr'] },
  { id: 'smsmode', nom: 'smsmode', cat: 'sms', concurrent: true, motifs: ['smsmode.com'] },
  { id: 'twilio', nom: 'Twilio', cat: 'sms', concurrent: true, motifs: ['twilio.com', 'twiliocdn'] },
  { id: 'esendex', nom: 'Esendex', cat: 'sms', concurrent: true, motifs: ['esendex.'] },
  { id: 'smsfactor', nom: 'SMSFactor', cat: 'sms', concurrent: true, motifs: ['smsfactor.com'] },
  { id: 'octopush', nom: 'Octopush', cat: 'sms', concurrent: true, motifs: ['octopush.com'] }
];

/* ⚠️ DEUX FAMILLES D'URL, ET ELLES NE PROUVENT PAS LA MÊME CHOSE (correction du 21/08).
   Ma première version capturait `href` sans distinction. Résultat sur sofy.fr : l'unique
   correspondance « guest-suite.com » venait d'un LIEN VERS UN ARTICLE DE BLOG cité en source
   (…/blog/statistiques-avis-clients), et l'audit annonçait « Guest Suite chargé sur le site » à
   propos de notre propre site. J'avais corrigé la mention textuelle et créé le lien sortant.

   · RESSOURCES CHARGÉES (script src, iframe src, link href, data-* de widgets) : c'est la preuve
     qu'un outil TOURNE sur la page. Un éditeur d'avis, un CRM, un chat s'y voient.
   · LIENS CLIQUABLES (<a href>) : de la navigation. Un article cité ne prouve rien.
     SAUF pour les canaux de contact — un bouton WhatsApp EST un <a href="https://wa.me/…">, il n'y
     a pas d'autre façon de le poser. Ces signatures portent donc `parLien: true`. */
function urlsDuDocument(html) {
  const charge = [], liens = [];
  const rxTag = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let t;
  while ((t = rxTag.exec(html)) !== null) {
    const tag = t[1].toLowerCase(), attrs = t[2];
    const cible = (tag === 'a' || tag === 'area') ? liens : charge;
    let m;
    const rxSrc = /(?:src|data-(?:src|url|domain|host))\s*=\s*["']([^"']{4,300})["']/gi;
    while ((m = rxSrc.exec(attrs)) !== null) cible.push(m[1].toLowerCase());
    // `href` charge une ressource sur <link> (feuille de style, préconnexion) ; sur <a> c'est un lien.
    const rxHref = /href\s*=\s*["']([^"']{4,300})["']/gi;
    while ((m = rxHref.exec(attrs)) !== null) {
      if (tag === 'link') charge.push(m[1].toLowerCase());
      else if (tag === 'a' || tag === 'area') liens.push(m[1].toLowerCase());
    }
  }
  return { charge: charge.join(' \n'), liens: liens.join(' \n') };
}

function urlSure(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(x.hostname)) return false;
    return true;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const site = String((req.body || {}).site || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!site || !site.includes('.')) return res.status(400).json({ erreur: 'site requis' });
  const url = 'https://' + site;
  if (!urlSure(url)) return res.status(400).json({ erreur: 'URL refusée' });

  // Les boutons de contact (WhatsApp, chat, formulaire) sont rarement sur la page d'accueil :
  // ils vivent sur « contact » ou « aide ». Ne scanner que la home faisait conclure « aucun outil
  // de messagerie » sur des sites qui en ont un — un constat faux dans un document client.
  const CHEMINS = ['', '/contact', '/nous-contacter', '/aide', '/service-client'];
  const lire = async (u) => {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SofyScrap/1.0)' } });
      if (r.ok && /text\/html/.test(r.headers.get('content-type') || '')) return (await r.text()).slice(0, 400000);
    } catch (_) { } finally { clearTimeout(to); }
    return '';
  };

  try {
    let html = await lire(url);
    if (!html) return res.status(200).json({ ok: true, technos: [], scanne: false });
    const pagesLues = ['/'];
    // Pages secondaires en parallèle : le coût est un fetch, le gain est un constat juste.
    const suites = await Promise.all(CHEMINS.slice(1).map(c => lire(url + c)));
    suites.forEach((h, k) => { if (h) { html += '\n' + h; pagesLues.push(CHEMINS[k + 1]); } });

    const bas = html.toLowerCase();
    const { charge, liens } = urlsDuDocument(bas);
    const technos = [], mentions = [];
    for (const s of SIGNATURES) {
      // Une ressource chargée prouve qu'un outil tourne. Pour un canal de contact, un lien suffit :
      // c'est ainsi qu'on pose un bouton WhatsApp.
      const installe = s.motifs.some(m => charge.includes(m))
        || (s.parLien && s.motifs.some(m => liens.includes(m)));
      if (installe) {
        technos.push({ id: s.id, nom: s.nom, cat: s.cat, concurrent: s.concurrent, nous: !!s.nous, charge: true });
      } else if (s.motifs.some(m => bas.includes(m))) {
        // Nommé quelque part — texte éditorial, ou lien vers un article du concurrent. Sur sofy.fr,
        // « guest-suite.com » n'apparaît QUE dans un lien vers un de leurs articles de blog.
        // Rendu à part, jamais compté comme équipement.
        mentions.push({ id: s.id, nom: s.nom, cat: s.cat, concurrent: s.concurrent, nous: !!s.nous,
          ou: s.motifs.some(m => liens.includes(m)) ? 'lien sortant' : 'texte de la page' });
      }
    }
    return res.status(200).json({ ok: true, technos, mentions, scanne: true, pages_lues: pagesLues });
  } catch (e) {
    return res.status(200).json({ ok: true, technos: [], scanne: false, detail: String(e.message || e).slice(0, 120) });
  }
}
