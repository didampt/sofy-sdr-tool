// /api/sources-veille.js — 📚 Bibliothèque des sources LinkedIn à surveiller (import de likers).
// Stockée dans config 'sources_veille' : [{nom, url, categorie, dernier_scrape, leads}].
// GET                      → { sources } (tout utilisateur connecté)
// POST {nom, url, categorie}          → ajoute
// POST {url, scrape:true, leads:n}    → marque « scrapé aujourd'hui » (+ compteur de leads)
// POST {url, supprimer:true}          → retire
// GET ?rappel=1 (cron lundi / superadmin) → DM Slack de rappel aux admins avec slack_id
// Catégories : concurrent · adjacent · media · salon · dom (voir reco du 07/08).

import { verifierToken, sql, ensureSchema } from './db.js';

// Amorçage : les sources recommandées le 07/08 (modifiable ensuite depuis l'outil)
const DEFAUTS = [
  { nom: 'Partoo', url: 'https://www.linkedin.com/company/partoo/posts/', categorie: 'concurrent' },
  { nom: 'Guest Suite', url: 'https://www.linkedin.com/company/guest-suite/posts/', categorie: 'concurrent' },
  { nom: 'Malou', url: 'https://www.linkedin.com/company/malou-io/posts/', categorie: 'concurrent' },
  { nom: 'Digitaleo', url: 'https://www.linkedin.com/company/digitaleo/posts/', categorie: 'concurrent' },
  { nom: 'Alcmeon', url: 'https://www.linkedin.com/company/alcmeon/posts/', categorie: 'concurrent' },
  { nom: 'Hey Pongo', url: 'https://www.linkedin.com/company/heypongo/posts/', categorie: 'concurrent' },
  { nom: 'SMS Partner', url: 'https://www.linkedin.com/company/sms-partner-fr/posts/', categorie: 'concurrent' },
  { nom: 'Zelty (caisse resto)', url: 'https://www.linkedin.com/company/zelty/posts/', categorie: 'adjacent' },
  { nom: 'Planity (beauté)', url: 'https://www.linkedin.com/company/planity/posts/', categorie: 'adjacent' },
  { nom: 'Zenchef (CHR)', url: 'https://www.linkedin.com/company/zenchef/posts/', categorie: 'adjacent' },
  { nom: 'LSA Commerce & Conso', url: 'https://www.linkedin.com/company/lsa/posts/', categorie: 'media' },
  { nom: 'Fédération française de la franchise', url: 'https://www.linkedin.com/company/federation-francaise-de-la-franchise/posts/', categorie: 'media' },
  { nom: 'All4Customer Paris', url: 'https://www.linkedin.com/company/all4customer/posts/', categorie: 'salon' },
  { nom: 'Franchise Expo Paris', url: 'https://www.linkedin.com/company/franchise-expo-paris/posts/', categorie: 'salon' },
  { nom: 'CCI Guadeloupe', url: 'https://www.linkedin.com/company/cci-des-iles-de-guadeloupe/posts/', categorie: 'dom' }
];

async function lire() {
  const rows = await sql`SELECT valeur FROM config WHERE cle = 'sources_veille'`;
  const v = rows.length ? rows[0].valeur : null;
  return Array.isArray(v) && v.length ? v : DEFAUTS.map(s => ({ ...s, dernier_scrape: null, leads: 0 }));
}
async function ecrire(liste) {
  await sql`INSERT INTO config (cle, valeur) VALUES ('sources_veille', ${JSON.stringify(liste)})
            ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify(liste)}`;
}
const jours = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

export default async function handler(req, res) {
  const estCron = !!req.headers['x-vercel-cron'];
  const user = estCron ? null : verifierToken(req);
  if (!estCron && !user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();

  try {
    // ── Rappel hebdo : DM Slack aux admins (cron lundi 7 h Paris) ──
    if (estCron || (req.query || {}).rappel) {
      if (!estCron && user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const sources = await lire();
      const froides = sources.map(s => ({ ...s, j: jours(s.dernier_scrape) }))
        .sort((a, b) => (b.j === null ? 9999 : b.j) - (a.j === null ? 9999 : a.j)).slice(0, 4);
      const LIB = { concurrent: '🥊', adjacent: '🤝', media: '📰', salon: '🎪', dom: '🏝️' };
      const lignes = froides.map(s => `• ${LIB[s.categorie] || '•'} <${s.url}|${s.nom}> — ${s.j === null ? 'jamais scrapé' : 'dernier scrape il y a ' + s.j + ' j'}`).join('\n');
      const texte = `📚 *Lundi — 20 minutes de veille LinkedIn*\nScrape les likers de 3-4 posts récents (20-80 réactions, sujet produit) :\n${lignes}\n\n👉 Sofy Scrap → 📥 Importer des likers (le script se copie dans la modale 🧰)\n_Sources à jour ? Modifie la liste dans la même modale._`;
      const admins = await sql`SELECT nom, slack_id FROM sdrs WHERE slack_id IS NOT NULL AND role IN ('admin','superadmin')`;
      let envoyes = 0;
      const token = process.env.SLACK_BOT_TOKEN;
      if (token) for (const a of admins) {
        try {
          const r = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: a.slack_id, text: texte })
          });
          if ((await r.json()).ok) envoyes++;
        } catch (_) {}
      }
      return res.status(200).json({ ok: true, rappel: true, admins: admins.length, envoyes, apercu: texte });
    }

    if (req.method === 'GET') {
      const sources = (await lire()).map(s => ({ ...s, jours: jours(s.dernier_scrape) }));
      return res.status(200).json({ ok: true, sources });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const url = String(b.url || '').trim();
      if (!url) return res.status(400).json({ erreur: 'url requise' });
      let liste = await lire();
      const i = liste.findIndex(s => s.url === url);
      if (b.supprimer) {
        liste = liste.filter(s => s.url !== url);
      } else if (b.scrape) {
        if (i >= 0) { liste[i].dernier_scrape = new Date().toISOString(); liste[i].leads = (liste[i].leads || 0) + (Number(b.leads) || 0); }
        else liste.unshift({ nom: String(b.nom || url).slice(0, 60), url, categorie: String(b.categorie || 'concurrent'), dernier_scrape: new Date().toISOString(), leads: Number(b.leads) || 0 });
      } else {
        if (i >= 0) return res.status(200).json({ ok: true, info: 'Source déjà présente' });
        liste.unshift({ nom: String(b.nom || url).slice(0, 60), url, categorie: String(b.categorie || 'concurrent'), dernier_scrape: null, leads: 0 });
      }
      await ecrire(liste.slice(0, 60));
      return res.status(200).json({ ok: true, sources: liste.map(s => ({ ...s, jours: jours(s.dernier_scrape) })) });
    }

    return res.status(405).json({ erreur: 'GET ou POST' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
