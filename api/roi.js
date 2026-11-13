// /api/roi.js — 💶 Simulateur ROI (onglet « Simulateur ROI ») : Budy Auto, Soview, SoReach SMS / RCS.
// Les moteurs et les études vivent dans roi-page.js (Budy Auto + gabarit) et roi-produits.js.
//
// GET  ?script=1   → le moteur de calcul + les profils, en JavaScript, pour le front (public :
//                    aucune donnée, et c'est ce qui garantit écran du commercial = document client)
// GET  ?jeton=…    → la configuration d'une étude existante (pour la rouvrir et la corriger)
// POST { config, client, destinataire?, jeton? } → crée l'étude (ou la met à jour sur le MÊME
//                    lien si jeton est fourni) et renvoie l'URL publique /p/<jeton>
//
// L'étude est rangée dans la table `prez` (module 'roi', contenu.type 'roi') : elle hérite ainsi
// gratuitement de tout ce qui fait la valeur d'une prez — compteur d'ouvertures, alerte Slack
// « le client lit », liens nominatifs 📤 Envoyer (RCS/SMS/email), expiration, « Mes présentations ».
// Le rendu est fait par /api/p.js, qui délègue à pageRoi() quand contenu.type === 'roi'.

import { verifierToken, sql, ensureSchema } from './db.js';
import { ensurePrez } from './prez.js';
import { calculerEtude, nettoyerConfig, scriptMoteurs, PRODUITS, produitDe } from './roi-produits.js';
import crypto from 'crypto';

const BASE_PUB = () => process.env.SOFY_BASE_PUBLIQUE || 'https://www.sofyscrap.com';

export default async function handler(req, res) {
  const q = req.query || {};

  if (req.method === 'GET' && q.script === '1') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(scriptMoteurs());
  }

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  await ensurePrez();
  const admin = ['admin', 'superadmin'].includes(user.role);

  if (req.method === 'GET') {
    const j = String(q.jeton || '');
    if (!j) return res.status(400).json({ erreur: 'jeton requis' });
    const [row] = await sql`SELECT jeton, client, sdr, destinataire, contenu FROM prez WHERE jeton = ${j} AND module = 'roi'`;
    if (!row) return res.status(404).json({ erreur: 'Étude introuvable' });
    if (!admin && row.sdr !== user.nom) return res.status(403).json({ erreur: 'Étude d\'un autre commercial' });
    return res.status(200).json({ ok: true, jeton: row.jeton, client: row.client, destinataire: row.destinataire,
      config: (row.contenu || {}).config || null, url: BASE_PUB() + '/p/' + row.jeton });
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST' });
  const b = req.body || {};
  const client = String(b.client || '').trim().slice(0, 120);
  if (!client) return res.status(400).json({ erreur: 'Nom du client requis : il figure sur la couverture.' });
  const config = nettoyerConfig(b.config);
  const r = calculerEtude(config);
  const contenu = { type: 'roi', produit: produitDe(config), client, config, _sdr: user.nom, resume: {
    gain_an: Math.round(r.gain_an), ca_an: Math.round(r.ca_an), roi: r.roi, heures_an: Math.round(r.heures_an)
  } };

  if (b.jeton) {
    const j = String(b.jeton);
    const [row] = await sql`SELECT sdr, ouvertures FROM prez WHERE jeton = ${j} AND module = 'roi'`;
    if (!row) return res.status(404).json({ erreur: 'Étude introuvable' });
    if (!admin && row.sdr !== user.nom) return res.status(403).json({ erreur: 'Tu ne peux modifier que tes propres études.' });
    await sql`UPDATE prez SET contenu = ${JSON.stringify(contenu)}::jsonb, client = ${client},
      destinataire = COALESCE(${b.destinataire || null}, destinataire),
      expire_le = GREATEST(expire_le, NOW() + INTERVAL '30 days') WHERE jeton = ${j}`;
    return res.status(200).json({ ok: true, jeton: j, url: BASE_PUB() + '/p/' + j,
      info: `Étude mise à jour sur le même lien${row.ouvertures ? ` — le client l'avait déjà ouverte ${row.ouvertures} fois` : ''}.` });
  }

  const jeton = crypto.randomBytes(9).toString('base64url');
  // 30 jours : un cycle de décision de concession dépasse souvent les 15 jours d'une prez.
  const jours = Math.max(1, Math.min(90, parseInt(process.env.ROI_JOURS_VALIDITE || '30', 10) || 30));
  await sql`INSERT INTO prez (jeton, client, module, sdr, liste_id, cle_fiche, destinataire, contenu, expire_le)
    VALUES (${jeton}, ${client}, 'roi', ${user.nom}, ${b.liste_id ? parseInt(b.liste_id, 10) : null},
            ${b.cle_fiche || null}, ${b.destinataire || null}, ${JSON.stringify(contenu)}::jsonb,
            NOW() + (${jours} || ' days')::interval)`;
  return res.status(200).json({ ok: true, jeton, url: BASE_PUB() + '/p/' + jeton, jours_validite: jours });
}
