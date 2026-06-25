// /api/synthese.js — Synthèse IA (Claude) de l'historique d'une fiche (notes + appels + RDV + envois).
// POST { historique, entreprise } -> { synthese } | { erreur }
import { verifierToken } from './db.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ erreur: 'ANTHROPIC_API_KEY manquante' });

  const b = req.body || {};
  const historique = String(b.historique || '').slice(0, 12000);
  const entreprise = String(b.entreprise || '').slice(0, 200);
  if (!historique.trim()) return res.status(200).json({ erreur: 'Aucun historique à synthétiser' });

  const prompt = `Tu es SDR chez Sofy. À partir de l'historique réel des échanges ci-dessous avec ${entreprise || 'le prospect'}, rédige une synthèse interne en français pour le CRM HubSpot.
Règles : factuel, concis, aucune invention (n'utilise que ce qui est dans l'historique). Si une info manque, ne l'invente pas.
Structure EXACTE (garde ces titres en gras) :
**Contexte** : l'entreprise / le contact, secteur et taille si connus.
**Historique des échanges** : appels, notes, RDV, emails — dans l'ordre, l'essentiel de ce qui s'est dit.
**Statut actuel** : où en est la relation (ex : intéressé, RDV pris, à relancer).
**Prochaine étape recommandée** : une seule action concrète.

Historique :
${historique}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) return res.status(200).json({ erreur: 'IA : ' + ((d && d.error && d.error.message) || r.status) });
    const txt = (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    if (!txt) return res.status(200).json({ erreur: 'IA : réponse vide' });
    return res.status(200).json({ synthese: txt });
  } catch (e) {
    return res.status(200).json({ erreur: 'IA erreur : ' + String(e.message || e).slice(0, 150) });
  }
}
