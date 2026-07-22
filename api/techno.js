// /api/techno.js — Détection des technologies présentes sur le site d'un prospect (gratuit : 1 fetch).
// POST { site } → { ok, technos:[{id, nom, cat, concurrent}] }
//   cat = 'avis' (outil d'e-réputation — concurrents Soview), 'chat' (messagerie web — angle SoConnect),
//         'marketing' (emailing/CRM — contexte SoReach).
// Usage : appelé par le pipeline 🚀 quand la fiche a un domaine. Signature = sous-chaîne dans le HTML
// de la page d'accueil (les widgets se chargent globalement). Anti-SSRF identique à gmb-liste.js.

import { verifierToken } from './db.js';

export const config = { maxDuration: 15 };

const SIGNATURES = [
  // Outils d'avis / e-réputation — concurrents directs de Soview
  { id: 'partoo', nom: 'Partoo', cat: 'avis', concurrent: true, motifs: ['partoo.co', 'partoo.com', 'widget.partoo'] },
  { id: 'guest-suite', nom: 'Guest Suite', cat: 'avis', concurrent: true, motifs: ['guest-suite.com', 'guestsuite', 'guest-suite'] },
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
  { id: 'whatsapp', nom: 'WhatsApp (lien/widget)', cat: 'chat', concurrent: false, motifs: ['wa.me/', 'api.whatsapp.com'] },
  // Marketing / emailing — contexte (l'entreprise investit déjà dans la relation client)
  { id: 'brevo', nom: 'Brevo (ex-Sendinblue)', cat: 'marketing', concurrent: true, motifs: ['sendinblue', 'sibforms', 'brevo.com'] },
  { id: 'mailchimp', nom: 'Mailchimp', cat: 'marketing', concurrent: false, motifs: ['mailchimp', 'list-manage.com'] },
  { id: 'hubspot', nom: 'HubSpot', cat: 'marketing', concurrent: false, motifs: ['js.hs-scripts', 'hsforms'] }
];

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

  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    let html = '';
    try {
      const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SofyScrap/1.0)' } });
      if (r.ok && /text\/html/.test(r.headers.get('content-type') || '')) html = (await r.text()).slice(0, 500000);
    } finally { clearTimeout(to); }
    if (!html) return res.status(200).json({ ok: true, technos: [], scanne: false });

    const bas = html.toLowerCase();
    const technos = [];
    for (const s of SIGNATURES) {
      if (s.motifs.some(m => bas.includes(m))) technos.push({ id: s.id, nom: s.nom, cat: s.cat, concurrent: s.concurrent });
    }
    return res.status(200).json({ ok: true, technos, scanne: true });
  } catch (e) {
    return res.status(200).json({ ok: true, technos: [], scanne: false, detail: String(e.message || e).slice(0, 120) });
  }
}
