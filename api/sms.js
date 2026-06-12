// /api/sms.js — Envoi du SMS de prospection via l'API Sofy (SoReach)
// POST {to, message, liste_id}
// Variables Vercel : SOFY_API_KEY + SOFY_SMS_ENDPOINT (URL de l'endpoint d'envoi SoReach)
// ⚠️ L'expéditeur et la mention STOP sont imposés : "Sofy" + " STOP au 36111" (conformité)

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
  if (!/STOP/i.test(message)) message = message.trim() + ' STOP au 36111';

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
