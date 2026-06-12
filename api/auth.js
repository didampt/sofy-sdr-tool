// /api/auth.js — Connexion réservée au domaine @sofy.fr
// POST {action:'login', email, password}  → jeton de session (7 jours)
// POST {action:'init',  email, password}  → 1re connexion du superadmin (définit son mot de passe)
// GET  ?action=me  (Authorization: Bearer) → infos de session
// La réinitialisation de mot de passe par email (Resend) arrive à l'étape suivante.

import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { sql, ensureSchema, signerToken, verifierToken } from './db.js';

function hacher(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function verifier(password, stocke) {
  const [salt, hash] = (stocke || '').split(':');
  if (!salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return calc.length === ref.length && timingSafeEqual(calc, ref);
}
function emailValide(email) {
  return /^[a-z0-9._%+-]+@sofy\.fr$/i.test((email || '').trim());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  try {
    if (req.method === 'GET' && req.query.action === 'me') {
      const u = verifierToken(req);
      if (!u) return res.status(401).json({ erreur: 'Session invalide ou expirée' });
      return res.status(200).json({ ok: true, user: { id: u.id, email: u.email, nom: u.nom, role: u.role } });
    }

    if (req.method === 'POST') {
      const { action, email, password } = req.body || {};
      const mail = (email || '').trim().toLowerCase();

      if (!emailValide(mail)) {
        return res.status(403).json({ erreur: 'Accès réservé aux adresses @sofy.fr' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ erreur: 'Mot de passe : 8 caractères minimum' });
      }

      const rows = await sql`SELECT * FROM sdrs WHERE LOWER(email) = ${mail} AND actif = TRUE`;
      if (!rows.length) {
        return res.status(403).json({ erreur: 'Utilisateur inconnu — demande à Didier de te créer un compte dans Paramètres' });
      }
      const user = rows[0];

      // Première connexion du superadmin : il définit son mot de passe
      if (action === 'init') {
        if (user.role !== 'superadmin') {
          return res.status(403).json({ erreur: 'Seul le superadmin peut s\'initialiser ici — ton mot de passe est défini par Didier dans Paramètres' });
        }
        if (user.password_hash) {
          return res.status(409).json({ erreur: 'Mot de passe déjà défini — utilise la connexion normale' });
        }
        await sql`UPDATE sdrs SET password_hash = ${hacher(password)} WHERE id = ${user.id}`;
        return res.status(200).json({ ok: true, token: signerToken(user), user: { id: user.id, email: user.email, nom: user.nom, role: user.role } });
      }

      // Connexion normale
      if (!user.password_hash) {
        return res.status(403).json({ erreur: user.role === 'superadmin' ? 'Première connexion : clique sur « Définir mon mot de passe (superadmin) »' : 'Mot de passe non défini — demande à Didier de le créer dans Paramètres' });
      }
      if (!verifier(password, user.password_hash)) {
        return res.status(401).json({ erreur: 'Email ou mot de passe incorrect' });
      }
      return res.status(200).json({ ok: true, token: signerToken(user), user: { id: user.id, email: user.email, nom: user.nom, role: user.role } });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
