// /api/sdrs.js — Gestion des SDR / utilisateurs et de leurs limites de crédits
// GET             → liste des SDR (actifs et inactifs)
// POST {nom, email?, limite_credits?}        → ajouter
// PUT  {id, nom?, email?, limite_credits?, actif?} → modifier (limite_credits: null = illimité)
// DELETE ?id=     → supprimer

import { scryptSync, randomBytes } from 'crypto';
import { sql, ensureSchema, verifierToken } from './db.js';

function normNumero(brut) {
  let n = String(brut || '').replace(/[\s.\-()]/g, '');
  if (!n) return null;
  if (n.startsWith('+')) return n;
  if (n.startsWith('00')) return '+' + n.slice(2);
  if (n.startsWith('0')) {
    const dom = { '0690': '+590', '0691': '+590', '0696': '+596', '0697': '+596', '0694': '+594', '0692': '+262', '0693': '+262', '0590': '+590', '0596': '+596', '0594': '+594', '0262': '+262' };
    const p4 = n.slice(0, 4);
    return (dom[p4] ? dom[p4] + n.slice(1) : '+33' + n.slice(1));
  }
  return '+' + n;
}

export default async function handler(req, res) {

  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'GET' && !['superadmin', 'admin'].includes(user.role)) {
    return res.status(403).json({ erreur: 'Réservé au superadmin (gestion des utilisateurs et crédits)' });
  }

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT id, nom, email, limite_credits, actif, role, ringover_numero, slack_id, (password_hash IS NOT NULL) AS mdp_defini FROM sdrs ORDER BY nom`;
      return res.status(200).json({ sdrs: rows });
    }

    if (req.method === 'POST') {
      const { nom, email = '', limite_credits = null, ringover_numero = null } = req.body || {};
      if (!nom || !nom.trim()) return res.status(400).json({ erreur: 'nom requis' });
      const lim = limite_credits === '' || limite_credits === null ? null : Number(limite_credits);
      const rows = await sql`INSERT INTO sdrs (nom, email, limite_credits, ringover_numero)
        VALUES (${nom.trim()}, ${email.trim()}, ${lim}, ${normNumero(ringover_numero)})
        ON CONFLICT (nom) DO UPDATE SET actif = TRUE
        RETURNING id, nom, email, limite_credits, actif, ringover_numero`;
      return res.status(200).json({ ok: true, sdr: rows[0] });
    }

    if (req.method === 'PUT') {
      const { id, nom, email, limite_credits, actif, ringover_numero, role, slack_id } = req.body || {};
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      const cur = await sql`SELECT * FROM sdrs WHERE id = ${parseInt(id)}`;
      if (!cur.length) return res.status(404).json({ erreur: 'SDR introuvable' });
      const c = cur[0];
      const lim = limite_credits === undefined ? c.limite_credits
                : (limite_credits === '' || limite_credits === null ? null : Number(limite_credits));
      const { password } = req.body || {};
      if (password) {
        if (password.length < 8) return res.status(400).json({ erreur: 'Mot de passe : 8 caractères minimum' });
        const salt = randomBytes(16).toString('hex');
        const h = salt + ':' + scryptSync(password, salt, 64).toString('hex');
        await sql`UPDATE sdrs SET password_hash = ${h} WHERE id = ${parseInt(id)}`;
      }
      const rows = await sql`UPDATE sdrs SET
          nom = ${nom !== undefined ? nom.trim() : c.nom},
          email = ${email !== undefined ? email.trim() : c.email},
          limite_credits = ${lim},
          actif = ${actif !== undefined ? !!actif : c.actif},
          ringover_numero = ${ringover_numero !== undefined ? normNumero(ringover_numero) : c.ringover_numero},
          slack_id = ${slack_id !== undefined ? (slack_id.trim() || null) : c.slack_id},
          role = ${user.role === 'superadmin' && role !== undefined && ['sdr','admin','superadmin'].includes(role) ? role : c.role}
        WHERE id = ${parseInt(id)}
        RETURNING id, nom, email, limite_credits, actif, ringover_numero, slack_id, role`;
      return res.status(200).json({ ok: true, sdr: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      await sql`DELETE FROM sdrs WHERE id = ${parseInt(id)}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    if ((err.message || '').includes('duplicate')) return res.status(409).json({ erreur: 'Ce nom existe déjà' });
    return res.status(500).json({ erreur: 'Erreur base de données', detail: err.message });
  }
}
