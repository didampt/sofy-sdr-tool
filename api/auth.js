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
// ── Anti-brute-force ──
const MAX_ECHECS = 5;          // nb d'échecs avant blocage
const FENETRE_MIN = 15;        // les échecs comptent sur cette fenêtre (minutes)
const BLOCAGE_MIN = 15;        // durée du blocage une fois le seuil atteint (minutes)
async function etatBlocage(mail) {
  const r = await sql`SELECT echecs, dernier_echec, bloque_jusqu FROM login_attempts WHERE email = ${mail}`;
  if (!r.length) return { bloque: false, resteSec: 0 };
  const row = r[0];
  if (row.bloque_jusqu && new Date(row.bloque_jusqu) > new Date()) {
    return { bloque: true, resteSec: Math.ceil((new Date(row.bloque_jusqu) - new Date()) / 1000) };
  }
  return { bloque: false, resteSec: 0 };
}
async function enregistrerEchec(mail) {
  // Réinitialise le compteur si le dernier échec est trop ancien (hors fenêtre)
  const r = await sql`SELECT echecs, dernier_echec FROM login_attempts WHERE email = ${mail}`;
  let echecs = 1;
  if (r.length && r[0].dernier_echec && (new Date() - new Date(r[0].dernier_echec)) < FENETRE_MIN * 60000) {
    echecs = (r[0].echecs || 0) + 1;
  }
  const bloque = echecs >= MAX_ECHECS ? new Date(Date.now() + BLOCAGE_MIN * 60000) : null;
  await sql`INSERT INTO login_attempts (email, echecs, dernier_echec, bloque_jusqu)
    VALUES (${mail}, ${echecs}, NOW(), ${bloque})
    ON CONFLICT (email) DO UPDATE SET echecs = ${echecs}, dernier_echec = NOW(), bloque_jusqu = ${bloque}`;
  return { echecs, bloque: !!bloque };
}
async function reinitTentatives(mail) {
  await sql`DELETE FROM login_attempts WHERE email = ${mail}`;
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
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  try {
    if (req.method === 'GET' && req.query.action === 'me') {
      const u = verifierToken(req);
      if (!u) return res.status(401).json({ erreur: 'Session invalide ou expirée' });
      return res.status(200).json({ ok: true, user: { id: u.id, email: u.email, nom: u.nom, role: u.role, ringover_numero: u.ringover_numero || null } });
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

      // Anti-brute-force : refuser si le compte est temporairement bloqué (uniquement pour login, pas init)
      if (action !== 'init') {
        const bloc = await etatBlocage(mail);
        if (bloc.bloque) {
          const min = Math.ceil(bloc.resteSec / 60);
          return res.status(429).json({ erreur: `Trop de tentatives. Réessaie dans ${min} minute${min > 1 ? 's' : ''}.` });
        }
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
        return res.status(200).json({ ok: true, token: signerToken(user), user: { id: user.id, email: user.email, nom: user.nom, role: user.role, ringover_numero: user.ringover_numero || null } });
      }

      // Connexion normale
      if (!user.password_hash) {
        return res.status(403).json({ erreur: user.role === 'superadmin' ? 'Première connexion : clique sur « Définir mon mot de passe (superadmin) »' : 'Mot de passe non défini — demande à Didier de le créer dans Paramètres' });
      }
      if (!verifier(password, user.password_hash)) {
        const e = await enregistrerEchec(mail);
        if (e.bloque) {
          return res.status(429).json({ erreur: `Trop de tentatives. Compte bloqué ${BLOCAGE_MIN} minutes.` });
        }
        const restant = MAX_ECHECS - e.echecs;
        return res.status(401).json({ erreur: `Email ou mot de passe incorrect.${restant <= 2 ? ` ${restant} tentative${restant > 1 ? 's' : ''} avant blocage.` : ''}` });
      }
      // Connexion réussie : on efface le compteur de tentatives
      await reinitTentatives(mail);
      return res.status(200).json({ ok: true, token: signerToken(user), user: { id: user.id, email: user.email, nom: user.nom, role: user.role, ringover_numero: user.ringover_numero || null } });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
