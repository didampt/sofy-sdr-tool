// /api/sms.js — Envoi du SMS de prospection via l'API Sofy (SoReach) : POST https://api.sofy.fr/v1/sms
// Variables Vercel : SOFY_API_KEY_ID + SOFY_API_KEY_SECRET
// Expéditeur "Sofy" + mention STOP selon la destination :
//   DOM (590 Gpe, 596 Mtq, 594 Guyane, 262 Réunion/Mayotte) → STOP au 36789 · Métropole → STOP au 36229

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

// Convertit un numéro FR/DOM vers le format international sans "+" attendu par l'API (ex : 590690112233)
function formatInternational(brut) {
  let n = String(brut || '').replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('0')) {
    const dom = { '0690': '590', '0691': '590', '0696': '596', '0697': '596', '0694': '594', '0692': '262', '0693': '262' };
    const p4 = n.slice(0, 4);
    if (dom[p4]) return dom[p4] + n.slice(1);   // 0690… → 590690…
    return '33' + n.slice(1);                    // 06/07… → 336/337…
  }
  return n; // déjà international (590…, 33…, etc.)
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const keyId = process.env.SOFY_API_KEY_ID;
  const keySecret = process.env.SOFY_API_KEY_SECRET;
  if (!keyId || !keySecret) {
    return res.status(500).json({ erreur: 'SOFY_API_KEY_ID ou SOFY_API_KEY_SECRET manquante dans Vercel' });
  }

  let { to, message = '', liste_id } = req.body || {};
  if (!to || !message.trim()) return res.status(400).json({ erreur: 'to et message requis' });
  const dest = formatInternational(to);
  if (!/^\d{10,14}$/.test(dest)) return res.status(400).json({ erreur: `Numéro invalide après normalisation : ${dest}` });

  // Mention STOP selon la destination (remplace toute mention existante pour garantir le bon numéro)
  const estDom = /^(590|596|594|262)/.test(dest);
  const stop = estDom ? 'STOP au 36789' : 'STOP au 36229';
  message = message.replace(/\s*STOP au \d{5}\.?\s*$/i, '').trim() + ' ' + stop;

  try {
    const r = await fetch('https://api.sofy.fr/v1/sms', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY-ID': keyId,
        'X-API-KEY-SECRET': keySecret
      },
      body: JSON.stringify({
        from: 'Sofy',
        to: dest,
        body: message,
        shortenUrls: true,
        isTransactional: false
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ erreur: 'API Sofy SMS', status: r.status, detail: JSON.stringify(data).slice(0, 300) });
    }
    // Comptage réel des crédits : 160 car = 1 SMS, au-delà segments de 153 car (en-tête concaténation)
    const lg = (message || '').length;
    const nbSms = lg <= 160 ? 1 : Math.ceil(lg / 153);
    await loggerConso(user, 'soreach', nbSms, liste_id);
    return res.status(200).json({ ok: true, id: data.id || null, statut: data.status || 'pending', destinataire: dest, credits: nbSms, caracteres: lg });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
