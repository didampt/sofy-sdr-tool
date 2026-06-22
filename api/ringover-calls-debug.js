// /api/ringover-calls-debug.js — TEMPORAIRE — inspecte la VRAIE réponse de l'API Ringover GET /calls.
// But : découvrir les noms de champs réels (lien d'enregistrement, numéros appelant/appelé, SDR, durée)
// avant de coder le matching. Réservé superadmin. Aucun impact sur Lemlist (on ne touche pas aux webhooks).
//
// Auth Ringover : header Authorization = clé brute (SANS "Bearer"). Base : https://public-api.ringover.com/v2

import { verifierToken } from './db.js';

const BASE = 'https://public-api.ringover.com/v2';

async function appel(path, key) {
  try {
    const r = await fetch(BASE + path, { headers: { 'Authorization': key } });
    let data = null, texte = null;
    try { data = await r.json(); } catch (e) { try { texte = await r.text(); } catch (e2) {} }
    return { path, status: r.status, data, texte };
  } catch (e) {
    return { path, erreur: String(e.message || e).slice(0, 200) };
  }
}

// Résume un objet "call" : liste ses clés + repère les champs ressemblant à un enregistrement / numéro
function resumeCall(call) {
  if (!call || typeof call !== 'object') return null;
  const cles = Object.keys(call);
  const interessants = {};
  for (const k of cles) {
    const kl = k.toLowerCase();
    if (/record|voicemail|file|url|mp3|audio|number|caller|callee|from|to|user|agent|duration|direction|type|date/.test(kl)) {
      let v = call[k];
      if (v && typeof v === 'object') v = '[objet: ' + Object.keys(v).join(',') + ']';
      interessants[k] = v;
    }
  }
  return { toutes_les_cles: cles, champs_interessants: interessants };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });

  const key = process.env.RINGOVER_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'RINGOVER_API_KEY manquante dans Vercel' });

  // On tente plusieurs variantes au cas où /calls exige des paramètres
  const tests = {};
  tests.A_calls_simple = await appel('/calls?limit_count=5', key);
  // Si A échoue (ex. 400 demande une période), on tente avec une fenêtre de dates (30 derniers jours)
  const depuis = new Date(Date.now() - 30 * 86400000).toISOString();
  const jusqua = new Date().toISOString();
  tests.B_calls_avec_dates = await appel(`/calls?limit_count=5&start_date=${encodeURIComponent(depuis)}&end_date=${encodeURIComponent(jusqua)}`, key);

  // Construit un résumé lisible à partir de la 1re réponse qui contient des appels
  let echantillon = null, source = null, total = null;
  for (const [nom, t] of Object.entries(tests)) {
    const d = t && t.data;
    if (!d) continue;
    // La liste d'appels peut s'appeler call_list / calls / list / data
    const liste = d.call_list || d.calls || d.list || (Array.isArray(d) ? d : null);
    if (Array.isArray(liste) && liste.length) {
      source = nom;
      total = d.total_call_count || d.total || d.count || liste.length;
      echantillon = liste.slice(0, 2).map(resumeCall);
      break;
    }
  }

  return res.status(200).json({
    note: echantillon
      ? "Réponse OK. Regarde 'champs_interessants' : on y cherche le lien d'enregistrement + les numéros + le SDR."
      : "Aucun appel listé. Vérifie le statut de A et B ci-dessous (401=clé/droits, 400=paramètres). Passe éventuellement un appel test puis relance.",
    source_utilisee: source,
    total_appels: total,
    echantillon,
    reponses_brutes: tests
  });
}
