// /api/sms.js — Envoi du SMS de prospection via l'API Sofy (SoReach)
// POST {to, message, liste_id}
// Variables Vercel : SOFY_API_KEY + SOFY_SMS_ENDPOINT (URL de l'endpoint d'envoi SoReach)
// ⚠️ Expéditeur "Sofy" imposé + mention STOP selon la destination :
//    DOM (+590 Gpe, +596 Mtq, +594 Guyane, +262 Réunion/Mayotte) → STOP au 36789 · Métropole → STOP au 36229

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const apiKey = process.env.SOFY_API_KEY;
  const endpoint = process.env.SOFY_SMS_ENDPOINT;
  if (!apiKey || !endpoint) {
    return res.status(500).json({ erreur: 'SOFY_API_KEY ou SOFY_SMS_ENDPOINT manquante — ajoute l\'URL de l\'endpoint d\'envoi SoReach dans Vercel' });
  }

  let { to, message = '', liste_id } = req.body || {};
  to = String(to || '').replace(/[\s.\-()]/g, '');
  if (!to || !message.trim()) return res.status(400).json({ erreur: 'to et message requis' });

  // Numéro STOP selon la destination
  const estDom = /^(\+|00)?(590|596|594|262)/.test(to.replace(/^0(69\d)/, '590$1'))
    || /^0(690|691|696|697|694|692|693)/.test(to);
  const stop = estDom ? 'STOP au 36789' : 'STOP au 36229';
  message = message.replace(/\s*STOP au \d{5}\.?\s*$/i, '').trim() + ' ' + stop;

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ to, message, sender: 'Sofy' })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ erreur: 'API SoReach', status: r.status, detail: JSON.stringify(data).slice(0, 300) });
    }
    await loggerConso(user, 'soreach', 1, liste_id);
    return res.status(200).json({ ok: true, reponse: data });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
