// /api/lemlist-import.js — le pont ENTRANT Lemlist → SofyScrap (chantier Étienne, GO Didier 23/09).
// Étienne source dans la People Database Lemlist ; SofyScrap importe la campagne, dédoublonne,
// enrichit (Google + registre via le pipeline 🚀 existant) et en fait une LISTE D'APPEL.
//
// GET ?action=campagnes            → { campagnes:[{id, nom, statut}] }
// GET ?action=leads&campagne=cam_x → { leads:[{email, prenom, nom, entreprise, telephone,
//                                     linkedin, ville, fonction}], nb, colonnes }
// Le front fait l'aperçu cochable, la dédup (/api/dedup) et la création (/api/listes) — même
// pattern que les autres modes. Aucune écriture ici : lecture seule côté Lemlist.

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

// Parseur CSV minimal mais correct (guillemets, virgules incluses, "" échappés) — l'export
// Lemlist est un CSV, pas du JSON.
function parseCsv(texte) {
  const lignes = [];
  let ligne = [], champ = '', dansQuotes = false;
  const s = String(texte || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (dansQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { champ += '"'; i++; }
        else dansQuotes = false;
      } else champ += c;
    } else if (c === '"') dansQuotes = true;
    else if (c === ',') { ligne.push(champ); champ = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      ligne.push(champ); champ = '';
      if (ligne.some(x => x !== '')) lignes.push(ligne);
      ligne = [];
    } else champ += c;
  }
  ligne.push(champ);
  if (ligne.some(x => x !== '')) lignes.push(ligne);
  return lignes;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET uniquement' });

  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante dans Vercel' });
  const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64');
  const headers = { 'Authorization': auth };
  const action = String((req.query || {}).action || '');

  try {
    if (action === 'campagnes') {
      // v2 renvoie { campaigns:[...] , pagination } ; l'ancienne API un tableau nu — défensif.
      const r = await fetch('https://api.lemlist.com/api/campaigns?version=v2&limit=100&sortBy=createdAt&sortOrder=desc', { headers });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) return res.status(502).json({ erreur: 'Lemlist campagnes : ' + r.status });
      const brut = Array.isArray(d) ? d : (d.campaigns || []);
      const campagnes = brut.map(c => ({ id: c._id || c.id, nom: c.name || c.nom || c._id, statut: c.status || '' }))
        .filter(c => c.id);
      return res.status(200).json({ campagnes });
    }

    if (action === 'leads') {
      const campagne = String(req.query.campagne || '').trim();
      if (!campagne) return res.status(400).json({ erreur: 'campagne requise' });
      const r = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/export/leads?state=all`, { headers });
      const texte = await r.text();
      if (!r.ok) return res.status(502).json({ erreur: 'Lemlist export : ' + r.status, detail: texte.slice(0, 150) });
      const lignes = parseCsv(texte);
      if (lignes.length < 2) return res.status(200).json({ leads: [], nb: 0, colonnes: lignes[0] || [] });
      const entetes = lignes[0].map(h => String(h || '').trim().toLowerCase());
      const idx = (noms) => { for (const n of noms) { const i = entetes.indexOf(n); if (i >= 0) return i; } return -1; };
      // _id du lead Lemlist : la SEULE adresse fiable pour le push retour (beaucoup de leads
      // People Database n'ont pas encore d'email — cas Anaëlle).
      const iId = idx(['_id', 'id', 'leadid', 'lead id', 'lead_id']);
      const iEmail = idx(['email']), iPrenom = idx(['firstname', 'first name', 'prenom', 'prénom']),
        iNom = idx(['lastname', 'last name', 'nom']), iEnt = idx(['companyname', 'company name', 'company', 'entreprise']),
        iTel = idx(['phone', 'telephone', 'téléphone']), iLk = idx(['linkedinurl', 'linkedin url', 'linkedin']),
        iVille = idx(['ville', 'city']), iFonction = idx(['jobtitle', 'job title', 'fonction', 'position', 'title']),
        iEtat = idx(['state', 'status']);
      // 2e FORMAT d'export (découvert 29/09, campagne Franck déménageurs) : un SCAN GOOGLE MAPS
      // fait dans Lemlist = des ENTREPRISES, pas des personnes. Colonnes standard vides, données
      // dans des colonnes personnalisées : Nom (nom de l'entreprise), Note (note Google),
      // companySiteWeb, Adresse, phone (préfixé d'une apostrophe anti-formule Excel).
      const iNomCustom = entetes.indexOf('nom'), iSite = idx(['companysiteweb', 'companywebsite', 'website', 'site web', 'site']),
        iAdresse = idx(['adresse', 'address']),
        // « note » (custom du scan, remplie) ET « notegoogle » (colonne d'équipe, souvent vide)
        // coexistent : on lira les deux et gardera la non-vide.
        iNoteC = entetes.indexOf('note'), iNoteG = entetes.indexOf('notegoogle');
      const leads = [];
      let sansEmail = 0;
      for (const l of lignes.slice(1)) {
        // L'email est OPTIONNEL : dans la People Database Lemlist, « Trouver l'email » n'a
        // souvent pas encore tourné (cas campagne Anaëlle 23/09 : 167 leads, 0 email).
        // Un lead vaut par son identité — nom, LinkedIn ou entreprise suffisent.
        const brutEmail = (iEmail >= 0 ? l[iEmail] : '').trim().toLowerCase();
        const email = brutEmail.includes('@') ? brutEmail : '';
        const lead = {
          lemlist_id: iId >= 0 ? (l[iId] || '').trim() : '',
          email,
          prenom: iPrenom >= 0 ? (l[iPrenom] || '').trim() : '',
          nom: iNom >= 0 ? (l[iNom] || '').trim() : '',
          entreprise: iEnt >= 0 ? (l[iEnt] || '').trim() : '',
          // Apostrophe de tête = garde anti-formule des exports ('+3347…) : on la retire
          telephone: (iTel >= 0 ? (l[iTel] || '').trim() : '').replace(/^'+/, ''),
          linkedin: iLk >= 0 ? (l[iLk] || '').trim() : '',
          ville: iVille >= 0 ? (l[iVille] || '').trim() : '',
          fonction: iFonction >= 0 ? (l[iFonction] || '').trim() : '',
          etat: iEtat >= 0 ? (l[iEtat] || '').trim() : '',
          site: iSite >= 0 ? (l[iSite] || '').trim() : '',
          adresse: iAdresse >= 0 ? (l[iAdresse] || '').trim() : '',
          note_google: (iNoteC >= 0 ? (l[iNoteC] || '').trim() : '') || (iNoteG >= 0 ? (l[iNoteG] || '').trim() : '')
        };
        // Scan Google Maps : le nom de l'entreprise est dans la colonne personnalisée « Nom »
        // (on ne l'utilise que si les champs personne sont vides — sur un export de personnes,
        // « nom » pourrait être un nom de famille).
        if (!lead.entreprise && !(lead.prenom + lead.nom).trim() && iNomCustom >= 0) {
          lead.entreprise = (l[iNomCustom] || '').trim();
        }
        // Ville extraite de l'adresse Google (« 92 Cr Lafayette, 69003 Lyon, France »)
        if (!lead.ville && lead.adresse) {
          const mv = lead.adresse.match(/\d{4,5}\s+([^,]+),/);
          if (mv) lead.ville = mv[1].trim();
        }
        if (!lead.email && !lead.linkedin && !(lead.prenom + lead.nom).trim() && !lead.entreprise && !lead.telephone) continue;
        if (!lead.email) sansEmail++;
        leads.push(lead);
      }
      // nb_lignes = lignes de données du CSV AVANT normalisation : si nb_lignes > nb, des lignes
      // sont jetées (identité vide) ; si nb_lignes < ce que montre Lemlist, le manque est côté
      // export Lemlist ou parseur (guillemet non échappé qui avale des lignes) — diag 29/09.
      return res.status(200).json({ leads: leads.slice(0, 1000), nb: leads.length, sans_email: sansEmail,
        colonnes: entetes, nb_lignes: lignes.length - 1, taille_csv: texte.length });
    }

    // ── Sonde superadmin : GET brut vers l'API Lemlist (diagnostic uniquement, lecture seule) ──
    if (action === 'brut') {
      if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const chemin = String(req.query.chemin || '');
      if (!/^[a-zA-Z0-9/_?=&.%-]+$/.test(chemin) || !/^(campaigns|leads|database|lists|schedules|team)\b/.test(chemin)) {
        return res.status(400).json({ erreur: 'chemin invalide (campaigns|leads|database|lists|schedules|team…)' });
      }
      const r = await fetch('https://api.lemlist.com/api/' + chemin, { headers });
      const texte = await r.text();
      return res.status(200).json({ status: r.status, type: r.headers.get('content-type') || '',
        longueur: texte.length, corps: texte.slice(0, 4000) });
    }

    return res.status(400).json({ erreur: 'action inconnue (campagnes|leads|brut)' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Import Lemlist', detail: String(e.message || e).slice(0, 200) });
  }
}
