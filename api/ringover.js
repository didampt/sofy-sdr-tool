// /api/ringover.js — Click-to-call : déclenche un appel Ringover (le poste du SDR sonne, puis le prospect)
// POST {to} — la ligne du SDR est lue dans config 'ringover' : { "alicia": "+590690…", "franck": "+336…" }
// Variable Vercel : RINGOVER_API_KEY (Ringover → dashboard.ringover.com → Développeurs → clé API)

import { sql, ensureSchema, verifierToken } from './db.js';

function intl(brut) {
  let n = String(brut || '').replace(/[\s.\-()]/g, '');
  if (n.startsWith('+')) return n;
  if (n.startsWith('00')) return '+' + n.slice(2);
  if (n.startsWith('0')) {
    const dom = { '0690': '+590', '0691': '+590', '0696': '+596', '0697': '+596', '0694': '+594', '0692': '+262', '0693': '+262' };
    const p4 = n.slice(0, 4);
    if (dom[p4]) return dom[p4] + n.slice(1);
    // fixes DOM : 0590/0596/0594/0262
    const fixe = { '0590': '+590', '0596': '+596', '0594': '+594', '0262': '+262' };
    if (fixe[p4]) return fixe[p4] + n.slice(1);
    return '+33' + n.slice(1);
  }
  return '+' + n;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.RINGOVER_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'RINGOVER_API_KEY manquante dans Vercel' });
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });
  await ensureSchema();

  const { to } = req.body || {};
  if (!to) return res.status(400).json({ erreur: 'to requis' });

  try {
    const rows = await sql`SELECT valeur FROM config WHERE cle = 'ringover'`;
    const cfg = rows.length ? rows[0].valeur : {};
    const ligne = cfg[user.email] || cfg[(user.email || '').split('@')[0]] || cfg[user.nom] || cfg.defaut;
    if (!ligne) {
      return res.status(400).json({ erreur: `Aucune ligne Ringover configurée pour ${user.email} — Paramètres → carte ☎️ Ringover` });
    }

    const r = await fetch('https://public-api.ringover.com/v2/callbacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
      body: JSON.stringify({
        from_number: intl(ligne).replace('+', ''),
        to_number: intl(to).replace('+', ''),
        timeout: 30
      })
    });
    const texte = await r.text();
    let data = {}; try { data = JSON.parse(texte); } catch (_) {}
    if (!r.ok) {
      return res.status(502).json({ erreur: 'Ringover', status: r.status, detail: (texte || '').slice(0, 250) });
    }
    return res.status(200).json({ ok: true, detail: 'Ton poste Ringover sonne — décroche, le prospect est appelé ensuite', reponse: data });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
