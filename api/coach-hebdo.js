// /api/coach-hebdo.js — 🎧 Coach d'appels : synthèse HEBDO (cron vendredi 15:00 UTC ≈ 17 h Paris).
// Agrège les analyses de la semaine (analyses_appels) → 1 DM de coaching par SDR (patterns
// récurrents + shadowing : les verbatims gagnants de TOUTE l'équipe) + 1 récap managers
// (admins avec slack_id). GET ?dry=1 : agrégats sans IA ni DM. Coût : ~0,02 €/SDR/semaine.

import { sql, ensureSchema, ensureCoach, loggerConso } from './db.js';

export const config = { maxDuration: 120 };

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return false;
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
    return !!(await r.json()).ok;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  const estCron = req.headers['x-vercel-cron'];
  const dry = (req.query || {}).dry === '1';
  if (!estCron) {
    try {
      const { verifierToken } = await import('./db.js');
      const user = verifierToken(req);
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    } catch (_) { return res.status(401).json({ erreur: 'Non autorisé' }); }
  }

  try {
    await ensureSchema();
    await ensureCoach();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante' });

    // Semaine courante : lundi → aujourd'hui (heure de Paris)
    const auj = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const d0 = new Date(auj + 'T12:00:00Z');
    d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7)); // lundi
    const du = d0.toISOString().slice(0, 10);

    const rows = await sql`SELECT call_id, sdr, jour, duree_sec, prospect, tags, note, "analyse"
      FROM analyses_appels WHERE jour >= ${du} ORDER BY sdr, note ASC`;
    if (!rows.length) return res.status(200).json({ ok: true, semaine_du: du, info: 'Aucune analyse cette semaine' });

    // Agrégats par SDR + verbatims gagnants de l'équipe (shadowing)
    const parSdr = {};
    const verbatims = [];
    for (const r of rows) {
      const an = r.analyse || {};
      const s = parSdr[r.sdr] = parSdr[r.sdr] || { n: 0, somme: 0, rdv: 0, sans_rdv: 0, actions: [], objections: [] };
      s.n++; s.somme += Number(r.note) || 0;
      if (an.proposition_rdv && an.proposition_rdv.faite) s.rdv++; else s.sans_rdv++;
      for (const a of (an.actions || [])) s.actions.push(a);
      for (const o of (an.objections || [])) s.objections.push(`« ${o.objection} » (réponse ${o.qualite || '?'})`);
      if (an.verbatim_gagnant && Number(r.note) >= 6) verbatims.push({ sdr: r.sdr, note: Number(r.note), v: an.verbatim_gagnant });
    }
    verbatims.sort((a, b) => b.note - a.note);
    const topVerbatims = verbatims.slice(0, 4);

    if (dry) return res.status(200).json({
      ok: true, simulation: true, semaine_du: du, analyses: rows.length,
      par_sdr: Object.fromEntries(Object.entries(parSdr).map(([n, s]) => [n, { appels: s.n, note_moy: Math.round(10 * s.somme / s.n) / 10, rdv_proposes: s.rdv, actions: s.actions.length, objections: s.objections.length }])),
      verbatims_gagnants: topVerbatims
    });

    const us = await sql`SELECT nom, role, slack_id FROM sdrs WHERE actif = TRUE`;
    const slackDe = {}; const admins = [];
    for (const u of us) { slackDe[u.nom] = u.slack_id || null; if (['admin', 'superadmin'].includes(u.role) && u.slack_id) admins.push(u); }

    // 1 synthèse IA courte par SDR (patterns, pas la liste brute des actions)
    let dms = 0, ia = 0;
    const shadow = topVerbatims.length
      ? '\n\n💬 *Les phrases qui ont marché cette semaine (équipe)* :\n' + topVerbatims.map(v => `• _« ${v.v} »_ (${v.sdr}, appel noté ${v.note}/10)`).join('\n')
      : '';
    for (const [nom, s] of Object.entries(parSdr)) {
      if (!slackDe[nom]) continue;
      let synthese = '';
      try {
        const prompt = `Tu es coach commercial. Voici les retours IA sur les ${s.n} appels analysés de ${nom} cette semaine (note moyenne ${Math.round(10 * s.somme / s.n) / 10}/10, RDV proposé dans ${s.rdv}/${s.n} appels).

Actions correctives relevées appel par appel :
${s.actions.slice(0, 20).map(a => '- ' + a).join('\n')}

Objections clients rencontrées :
${s.objections.slice(0, 12).map(o => '- ' + o).join('\n') || '- aucune'}

Rédige un coaching hebdo en français, TUTOIE ${nom}, ton bienveillant et direct, format Slack (pas de markdown #), MAX 120 mots :
1. LE pattern n°1 à corriger (celui qui revient le plus)
2. UN point fort à garder
3. UN défi concret pour la semaine prochaine (mesurable)`;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await r.json().catch(() => null);
        if (r.ok) { synthese = (data.content || []).map(c => c.text || '').join('').trim(); ia++; }
      } catch (_) {}
      if (!synthese) synthese = `Note moyenne ${Math.round(10 * s.somme / s.n) / 10}/10 sur ${s.n} appels — RDV proposé dans ${s.rdv} appel(s). Détail par appel dans 🎧 Journal des appels.`;
      const ok = await envoyerDM(slackDe[nom], `🎧 *Ton coaching de la semaine* (${s.n} appel${s.n > 1 ? 's' : ''} analysé${s.n > 1 ? 's' : ''} · note moyenne ${Math.round(10 * s.somme / s.n) / 10}/10)\n\n${synthese}${shadow}\n\n_Le détail appel par appel est dans 🎧 Journal des appels._`);
      if (ok) dms++;
    }

    // Récap managers (données brutes, sans IA)
    const lignes = Object.entries(parSdr).map(([n, s]) => `• ${n} : ${s.n} appels analysés · note moy ${Math.round(10 * s.somme / s.n) / 10}/10 · RDV proposé ${s.rdv}/${s.n}`).join('\n');
    for (const a of admins) await envoyerDM(a.slack_id, `🎧 *Coach d'appels — récap semaine* (depuis le ${du})\n${lignes}${shadow}`);

    if (ia) await loggerConso({ nom: 'système' }, 'ia_claude', ia, null);
    return res.status(200).json({ ok: true, semaine_du: du, analyses: rows.length, dms_sdr: dms, recap_admins: admins.length });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
