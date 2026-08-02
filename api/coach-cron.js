// /api/coach-cron.js — 🎧 Coach d'appels : analyse IA quotidienne des appels de la VEILLE.
// Cron 04:30 UTC. Source : transcriptions Ringover (BABEL, speeches par canal : 0 = SDR, 1 = client),
// croisées avec /calls (sortants, décrochés, ≥ 60 s). Grille cold-call B2B par claude-sonnet-4-6 →
// table analyses_appels (1 ligne/appel, call_id UNIQUE = jamais ré-analysé, ~0,02 €/appel).
// GET ?dry=1 : liste les appels qui SERAIENT analysés, sans appel IA ni écriture.
// GET ?jour=YYYY-MM-DD : rejoue un jour précis (superadmin). Plafond : 60 analyses/run.
//
// Arbitrages Didier 03/08 : tous les appels ≥ 60 s · transparent (le SDR voit ses analyses,
// les admins voient tout) · analyse quotidienne + coaching hebdo (Lot 2).

import { sql, ensureSchema, ensureCoach, loggerConso } from './db.js';

export const config = { maxDuration: 300 };

const BASE = 'https://public-api.ringover.com/v2';
const PLAFOND_RUN = 60;
const MIN_DUREE = 60;

function jourParis(d) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}

// Dialogue lisible depuis les speeches (canal 0 = SDR appelant, canal 1 = client) + ratio de parole
function dialogueDe(td) {
  const sp = (td && Array.isArray(td.speeches)) ? [...td.speeches].sort((a, b) => (a.start || 0) - (b.start || 0)) : [];
  let dSdr = 0, dCli = 0;
  const lignes = [];
  for (const s of sp) {
    const qui = s.channelId === 0 ? 'SDR' : 'CLIENT';
    if (s.channelId === 0) dSdr += s.duration || 0; else dCli += s.duration || 0;
    const txt = String(s.text || '').trim();
    if (!txt) continue;
    // Fusion des tours consécutifs du même locuteur (lisibilité + tokens)
    if (lignes.length && lignes[lignes.length - 1].qui === qui) lignes[lignes.length - 1].txt += ' ' + txt;
    else lignes.push({ qui, txt });
  }
  const total = dSdr + dCli;
  return {
    texte: lignes.map(l => `${l.qui} : ${l.txt}`).join('\n').slice(0, 9000),
    ratio_sdr: total ? Math.round(100 * dSdr / total) : null
  };
}

async function analyserAppel(apiKey, appel, dial) {
  const prompt = `Tu es un coach commercial senior spécialisé en cold call B2B (cible : commerces et PME françaises, produits : Soview — pilotage de fiche Google et collecte d'avis —, SoConnect — centralisation des conversations clients —, SoReach — campagnes SMS).

Voici la transcription d'un appel sortant de prospection. SDR : ${appel.sdr}. Prospect : ${appel.prospect || 'inconnu'}. Durée : ${appel.duree_sec}s. Ratio de parole du SDR : ${dial.ratio_sdr != null ? dial.ratio_sdr + ' %' : 'inconnu'}${appel.tags ? '. Issue notée par le SDR : ' + appel.tags : ''}.
NB : transcription automatique — tolère les mots mal transcrits, reconstitue le sens probable.

${dial.texte}

Analyse l'appel selon cette grille et réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{
 "note": 0-10 (sévère mais juste : 5 = appel moyen, 8+ = exemplaire),
 "accroche": {"ok": true|false, "commentaire": "les 15 premières secondes : personnalisée ? factuelle ? (1 phrase)"},
 "decouverte": {"questions_posees": n, "commentaire": "le SDR a-t-il creusé le besoin avant de pitcher ? (1 phrase)"},
 "ecoute": "le ratio de parole et les interruptions : 1 phrase",
 "objections": [{"objection": "ce que dit le client (court)", "reponse_sdr": "comment le SDR a répondu (court)", "qualite": "bonne|moyenne|faible"}],
 "proposition_rdv": {"faite": true|false, "explicite": true|false, "commentaire": "un créneau précis a-t-il été proposé ? (1 phrase)"},
 "verbatim_gagnant": "LA meilleure phrase du SDR dans cet appel (citation exacte) ou null",
 "actions": ["action corrective concrète n°1", "action corrective concrète n°2"],
 "resume": "2 phrases : ce qui s'est joué dans cet appel et pourquoi il a (ou n'a pas) abouti"
}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1400, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error('API Claude : ' + ((data && data.error && data.error.message) || r.status));
  const brut = ((data.content || []).map(c => c.text || '').join('')).replace(/```json|```/g, '');
  const p = JSON.parse(brut.slice(brut.indexOf('{'), brut.lastIndexOf('}') + 1));
  p.ratio_parole_sdr = dial.ratio_sdr;
  return p;
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
  const key = process.env.RINGOVER_API_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!key || !apiKey) return res.status(500).json({ erreur: 'RINGOVER_API_KEY ou ANTHROPIC_API_KEY manquante' });
  await ensureSchema();
  await ensureCoach();

  // Jour analysé = la veille (heure de Paris) ; rejouable via ?jour=
  let jour = String((req.query || {}).jour || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) {
    const h = new Date(); h.setDate(h.getDate() - 1);
    jour = jourParis(h);
  }

  try {
    // ── 1. Appels éligibles du jour : sortants, décrochés, ≥ 60 s (+ SDR via table sdrs) ──
    const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);
    const byEmail = {}, byNum = {};
    const us = await sql`SELECT nom, email, ringover_numero FROM sdrs WHERE actif = TRUE`;
    for (const u of us) {
      if (u.email) byEmail[u.email.toLowerCase().trim()] = u.nom;
      if (u.ringover_numero) { const k = cle9(u.ringover_numero); if (k) byNum[k] = u.nom; }
    }
    const appels = new Map(); // call_id -> {sdr, duree_sec, tags, prospect?}
    for (let p = 0; p < 2; p++) {
      const r = await fetch(`${BASE}/calls?limit_count=1000&limit_offset=${p * 1000}`, { headers: { Authorization: key } });
      const d = await r.json().catch(() => ({}));
      const liste = (d && d.call_list) || [];
      if (!liste.length) break;
      let resteJour = false;
      for (const c of liste) {
        const j = c.start_time ? jourParis(new Date(c.start_time)) : '';
        if (j > jour) { resteJour = true; continue; }
        if (j < jour) continue;
        resteJour = true;
        if (c.direction !== 'out' || !c.is_answered || (c.incall_duration || 0) < MIN_DUREE) continue;
        const em = c.user && c.user.email ? c.user.email.toLowerCase().trim() : '';
        const sdr = byEmail[em] || byNum[cle9(c.from_number)] || null;
        if (!sdr) continue;
        appels.set(String(c.call_id), {
          sdr, duree_sec: c.incall_duration || 0,
          tags: (c.tags || []).map(t => t.name).join(', ') || null,
          prospect: (c.contact && (c.contact.concat_name || c.contact.company)) ? [c.contact.concat_name, c.contact.company].filter(Boolean).join(' · ') : null
        });
      }
      if (!resteJour || liste.length < 1000) break;
    }

    // ── 2. Transcriptions correspondantes (paginées) ──
    const transcriptions = new Map(); // call_id -> transcription_data
    for (let p = 0; p < 4; p++) {
      const r = await fetch(`${BASE}/transcriptions?limit_count=100&limit_offset=${p * 100}`, { headers: { Authorization: key } });
      const arr = await r.json().catch(() => null);
      if (!Array.isArray(arr) || !arr.length) break;
      for (const t of arr) {
        const cid = String(t.call_id || '');
        if (appels.has(cid) && t.transcription_status === 'DONE' && t.transcription_data) transcriptions.set(cid, t.transcription_data);
      }
      if (arr.length < 100) break;
      // Les transcriptions arrivent triées par date desc : on s'arrête quand on est passé avant le jour cible
      const derniere = arr[arr.length - 1];
      if (derniere && derniere.creation_date && jourParis(new Date(derniere.creation_date)) < jour) break;
    }

    // ── 3. Déjà analysés = jamais re-payés ──
    const deja = new Set((await sql`SELECT call_id FROM analyses_appels WHERE jour = ${jour}`).map(r => r.call_id));
    const candidats = [...appels.entries()]
      .filter(([cid]) => transcriptions.has(cid) && !deja.has(cid))
      .slice(0, PLAFOND_RUN);

    if (dry) return res.status(200).json({
      ok: true, simulation: true, jour,
      appels_eligibles: appels.size, avec_transcription: [...appels.keys()].filter(c => transcriptions.has(c)).length,
      deja_analyses: deja.size, analyseraient: candidats.length,
      apercu: candidats.slice(0, 8).map(([cid, a]) => ({ call_id: cid, sdr: a.sdr, duree: a.duree_sec, prospect: a.prospect, tags: a.tags }))
    });

    // ── 4. Analyse Claude appel par appel ──
    let faits = 0, erreurs = 0;
    const parSdr = {};
    for (const [cid, a] of candidats) {
      try {
        const dial = dialogueDe(transcriptions.get(cid));
        if (!dial.texte || dial.texte.length < 200) continue; // transcription vide/inutilisable
        const analyse = await analyserAppel(apiKey, a, dial);
        await sql`INSERT INTO analyses_appels (call_id, sdr, jour, duree_sec, prospect, tags, note, analyse)
          VALUES (${cid}, ${a.sdr}, ${jour}, ${a.duree_sec}, ${a.prospect}, ${a.tags}, ${Number(analyse.note) || null}, ${JSON.stringify(analyse)})
          ON CONFLICT (call_id) DO NOTHING`;
        faits++;
        parSdr[a.sdr] = (parSdr[a.sdr] || 0) + 1;
      } catch (_) { erreurs++; }
    }
    if (faits) await loggerConso({ nom: 'système', role: 'superadmin' }, 'ia_claude', faits, null);

    return res.status(200).json({ ok: true, jour, appels_eligibles: appels.size, analyses: faits, erreurs, par_sdr: parSdr });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: e.message });
  }
}
