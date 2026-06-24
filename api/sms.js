// /api/sms.js — Envoi du SMS de prospection (SoReach). Logique d'envoi mutualisee dans db.js (envoyerSmsSofy).
import { verifierToken, limiteAtteinte, envoyerSmsSofy } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const { to, message = '', liste_id } = req.body || {};
  if (!to || !message.trim()) return res.status(400).json({ erreur: 'to et message requis' });

  const r = await envoyerSmsSofy({ to, message, user, liste_id });
  if (!r.ok) return res.status(502).json({ erreur: 'API Sofy SMS', status: r.status, detail: r.detail });
  return res.status(200).json({ ok: true, id: r.id, statut: r.statut, destinataire: r.destinataire, credits: r.credits, caracteres: r.caracteres });
}
