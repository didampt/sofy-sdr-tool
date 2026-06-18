// /api/config.js — Configuration des envois (campagnes Lemlist, pipeline HubSpot, SMS)
// GET → toute la config · PUT {cle, valeur} → modifier (superadmin)
import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT cle, valeur FROM config`;
      const out = {};
      for (const r of rows) out[r.cle] = r.valeur;
      return res.status(200).json({ config: out });
    }
    if (req.method === 'PUT') {
      if (!['superadmin','admin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé au superadmin' });
      const { cle, valeur } = req.body || {};
      if (!cle || valeur === undefined) return res.status(400).json({ erreur: 'cle et valeur requis' });
      await sql`INSERT INTO config (cle, valeur) VALUES (${cle}, ${JSON.stringify(valeur)})
                ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify(valeur)}`;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur base', detail: err.message });
  }
}
