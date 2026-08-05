// /api/hotlead.js — ➕ Hot lead MANUEL : une demande entrante (téléphone, email, salon…) devient
// une fiche de la liste Hot Leads partagée, comme un signal automatique (tuile 🔥 du cockpit,
// claim « Je prends », enrichissement auto au chargement). Accessible à tout utilisateur connecté.
// POST { nom_complet, entreprise, fonction?, email?, telephone?, source?, detail? }

import { verifierToken, ensureSchema, ajouterHotLead, sql } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureSchema();
  const b = req.body || {};
  const nom = String(b.nom_complet || '').trim();
  const entreprise = String(b.entreprise || '').trim();
  if (!nom && !entreprise) return res.status(400).json({ erreur: 'nom_complet ou entreprise requis' });

  try {
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'hotleads'`;
    const cfgHL = cfgRows.length ? cfgRows[0].valeur : {};
    const source = String(b.source || 'demande entrante').slice(0, 60);
    const r = await ajouterHotLead({
      nom_complet: nom || null,
      entreprise: entreprise || null,
      fonction: String(b.fonction || '').slice(0, 120),
      email: String(b.email || '').trim().toLowerCase() || null,
      telephone: String(b.telephone || '').trim() || null,
      source: `manuel — ${source}`,
      type: 'manuel',
      detail: `📞 ${source}${b.detail ? ' — ' + String(b.detail).slice(0, 300) : ''} (saisi par ${user.nom})`
    }, cfgHL);
    if (!r.ajoute) return res.status(200).json({ ok: true, ajoute: false, info: 'Déjà présent dans les Hot Leads (dédup)' });
    // Annonce au canal équipe (même canal que les signaux)
    try {
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🔥 *Hot lead manuel* — ${nom || entreprise}${entreprise && nom ? ' (' + entreprise + ')' : ''}\n📞 ${source}${b.detail ? ' — ' + String(b.detail).slice(0, 200) : ''}\nSaisi par *${user.nom}* — visible dans la tuile 🔥 de « Ma journée »` }) });
    } catch (_) {}
    return res.status(200).json({ ok: true, ajoute: true, liste_id: r.liste_id, cle_fiche: r.cle_fiche });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
