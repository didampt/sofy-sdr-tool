// /api/verrou.js — Verrou applicatif anti-double-enrichissement des Hot Leads
// POST { liste_id, signal_cle, action } · action = 'prendre' (défaut) | 'liberer'
// 'prendre'  → pose enrichi_par = SDR courant si la fiche est libre (<5 min, pas de score)
//              renvoie { ok:true } ou { ok:false, par, depuis } si déjà prise
// 'liberer'  → retire le verrou (appelé après enrichissement terminé)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const { verifierToken, verrouHotLead, libererHotLead } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const { liste_id, signal_cle, action = 'prendre' } = req.body || {};
  if (!liste_id || !signal_cle) return res.status(400).json({ erreur: 'liste_id et signal_cle requis' });

  try {
    if (action === 'liberer') {
      await libererHotLead(liste_id, signal_cle);
      return res.status(200).json({ ok: true, libere: true });
    }
    const r = await verrouHotLead(liste_id, signal_cle, user.nom);
    return res.status(200).json(r);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur verrou', detail: e.message });
  }
}
