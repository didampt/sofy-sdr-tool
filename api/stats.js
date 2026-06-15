// /api/stats.js — Statistiques de consommation
// GET ?liste_id=…   → coût de la liste (tous utilisateurs connectés)
// GET               → stats globales : par SDR (mois en cours), par liste, tarifs (SUPERADMIN)
// PUT {api, prix}   → modifier un tarif unitaire (SUPERADMIN)

import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  try {
    // ── Coût d'une liste (affiché dans les résultats) ──
    if (req.method === 'GET' && req.query.liste_id) {
      const id = parseInt(req.query.liste_id);
      const rows = await sql`
        SELECT c.api, SUM(c.quantite)::float AS quantite, SUM(c.quantite * COALESCE(t.prix, 0))::float AS cout
        FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
        WHERE c.liste_id = ${id} GROUP BY c.api ORDER BY cout DESC`;
      const cout_total = rows.reduce((s, r) => s + Number(r.cout), 0);
      return res.status(200).json({ cout_total: Math.round(cout_total * 100) / 100, par_api: rows });
    }

    if (req.method === 'GET') {
      if (!['superadmin','admin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé au superadmin' });

      // Par SDR — mois en cours
      const parSdr = await sql`
        SELECT c.sdr, c.api, SUM(c.quantite)::float AS quantite, SUM(c.quantite * COALESCE(t.prix, 0))::float AS cout
        FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
        WHERE date_trunc('month', c.created_at) = date_trunc('month', NOW())
        GROUP BY c.sdr, c.api ORDER BY c.sdr, cout DESC`;

      // Par liste (30 dernières) + % de réussite d'enrichissement calculé sur les contacts
      const listes = await sql`
        SELECT l.id, l.nom, l.sdr, l.total, l.created_at, l.entreprises,
               COALESCE((SELECT SUM(c.quantite * COALESCE(t.prix, 0))
                         FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
                         WHERE c.liste_id = l.id), 0)::float AS cout
        FROM listes l ORDER BY l.created_at DESC LIMIT 30`;
      const parListe = listes.map(l => {
        let contacts = 0, emails = 0, mobiles = 0, telGmb = 0, enrichis = 0, fichesAvecGmbTel = 0;
        const estMobileNum = t => /^(\+?(33)?\s?0?[67]|\+?(590|596|594|262)|0(690|691|696|697|694|692|693))/.test(String(t || '').replace(/[\s.\-()]/g, ''));
        for (const e of (l.entreprises || [])) {
          const cs = e.contacts || (e.dirigeant ? [{ enrich: e.enrich }] : []);
          if (e.gmb && e.gmb.telephone) { telGmb++; if (estMobileNum(e.gmb.telephone)) {} }
          for (const c of cs) {
            contacts++;
            const en = c.enrich || {};
            const aEmail = !!en.email;
            const aMobile = !!(en.mobile || (en.telephone && estMobileNum(en.telephone)));
            if (aEmail) emails++;
            if (aMobile) mobiles++;
            if (aEmail || aMobile || (c.enrich && c.enrich.telephone)) enrichis++;
          }
        }
        return {
          id: l.id, nom: l.nom, sdr: l.sdr, total: l.total, created_at: l.created_at,
          cout: Math.round(Number(l.cout) * 100) / 100,
          contacts, emails, mobiles, tel_gmb: telGmb, enrichis,
          pct_emails: contacts ? Math.round(100 * emails / contacts) : 0,
          pct_mobiles: contacts ? Math.round(100 * mobiles / contacts) : 0,
          pct_tel_gmb: l.total ? Math.round(100 * telGmb / l.total) : 0,
          pct_enrichi: contacts ? Math.round(100 * enrichis / contacts) : 0,
          cout_par_contact_enrichi: enrichis ? Math.round(100 * Number(l.cout) / enrichis) / 100 : null
        };
      });

      const tarifs = await sql`SELECT api, prix FROM tarifs ORDER BY api`;
      const limites = await sql`SELECT nom, limite_credits FROM sdrs WHERE actif = TRUE ORDER BY nom`;
      return res.status(200).json({ par_sdr: parSdr, par_liste: parListe, tarifs, limites });
    }

    // ── Modification d'un tarif ──
    if (req.method === 'PUT') {
      if (!['superadmin','admin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé au superadmin' });
      const { api, prix } = req.body || {};
      if (!api || prix === undefined || isNaN(Number(prix))) return res.status(400).json({ erreur: 'api et prix requis' });
      await sql`INSERT INTO tarifs (api, prix) VALUES (${api}, ${Number(prix)})
                ON CONFLICT (api) DO UPDATE SET prix = ${Number(prix)}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur base de données', detail: err.message });
  }
}
