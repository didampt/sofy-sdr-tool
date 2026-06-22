// /api/basile-geo.js — TEMPORAIRE — Quelle méthode géo cible vraiment les DOM ?
// Tout est en limit:1-3 (comptage), donc GRATUIT. Réservé superadmin.
import { verifierToken } from './db.js';

const BASE = 'https://api.basile.cc';

async function probePeople(label, filters, key) {
  try {
    const r = await fetch(BASE + '/people/find', {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3, filters })
    });
    const d = await r.json().catch(() => null);
    const leads = (d && d.leads) || [];
    return {
      label, type: 'personnes', status: r.status,
      total: (d && d.total != null) ? d.total : null,
      apercu: leads.map(l => {
        const x = l.data || {};
        const ville = x.result_city || x.location_city || '?';
        const pays = x.result_country_code || x.location_country_code || '?';
        const role = x.result_role || x.current_job_title || '?';
        return `${ville}/${pays} — ${role}`;
      })
    };
  } catch (e) { return { label, type: 'personnes', erreur: String(e.message || e).slice(0, 80) }; }
}

async function probeCompanies(label, filters, key) {
  try {
    const r = await fetch(BASE + '/companies/find', {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3, filters })
    });
    const d = await r.json().catch(() => null);
    const list = (d && (d.companies || d.leads || d.results)) || [];
    return {
      label, type: 'entreprises', status: r.status,
      total: (d && d.total != null) ? d.total : null,
      apercu: list.map(c => {
        const x = c.data || c || {};
        return (x.company_name || x.name || x.denomination || '?') + ' — CP ' + (x.headquarters_postal_code || x.postal_code || '?');
      })
    };
  } catch (e) { return { label, type: 'entreprises', erreur: String(e.message || e).slice(0, 80) }; }
}

// Codes postaux d'un DOM (971xx..) — on énumère 00..99
function cp(prefix) { const a = []; for (let i = 0; i < 100; i++) a.push(prefix + String(i).padStart(2, '0')); return a; }

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const role = { include: ['Directeur Commercial', 'Directrice Commerciale', 'Directeur des Ventes'] };
  const nafAuto = { include: ['45.31Z', '45.32Z', '45.11Z', '45.20A'] };
  const out = [];

  // --- PERSONNES : le bon champ géo ? ---
  out.push(await probePeople('① FR + rôle (référence métropole)', { result_country_code: { include: ['FR'] }, result_role: role }, key));
  out.push(await probePeople('② Pays = GP seul (Guadeloupe ISO)', { result_country_code: { include: ['GP'] } }, key));
  out.push(await probePeople('③ Pays = GP,MQ,GF,RE (DOM ISO)', { result_country_code: { include: ['GP', 'MQ', 'GF', 'RE'] } }, key));
  out.push(await probePeople('④ DOM ISO + rôle (cible réelle)', { result_country_code: { include: ['GP', 'MQ', 'GF', 'RE'] }, result_role: role }, key));
  out.push(await probePeople('⑤ result_region=Guadeloupe (champ supposé)', { result_region: { include: ['Guadeloupe'] } }, key));

  // --- ENTREPRISES : approche "entreprise d'abord" viable en DOM ? ---
  out.push(await probeCompanies('⑥ Entreprises CP Guadeloupe 971xx', { headquarters_postal_code: { include: cp('971') } }, key));
  out.push(await probeCompanies('⑦ Entreprises auto (NAF) CP 971xx', { headquarters_postal_code: { include: cp('971') }, naf_code: nafAuto }, key));

  return res.status(200).json({
    note: 'Compare les TOTAUX et les villes en aperçu. Le bon champ géo DOM = celui qui donne un total RAISONNABLE avec des villes DOM. ⑥/⑦ disent si l\'approche entreprise-d\'abord est viable.',
    out
  });
}
