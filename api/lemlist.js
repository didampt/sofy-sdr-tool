// /api/lemlist.js — "Pas de décroché" → le lead part (ou est mis à jour) en séquence Lemlist
// 1) upsert du CONTACT (champs unifiés : nom, société, téléphone, LinkedIn) 2) ajout/MAJ du LEAD dans la campagne
// POST {liste_id, produit, proprietaire, contact:{email,prenom,nom}, variables:{…}, sms}

import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante dans Vercel' });
  if (sql) await ensureSchema();

  const { produit, contact = {}, variables = {}, proprietaire, liste_id } = req.body || {};
  if (!contact.email) return res.status(400).json({ erreur: 'contact.email requis' });

  try {
    let cfg = {};
    if (sql) {
      const rows = await sql`SELECT valeur FROM config WHERE cle = 'lemlist'`;
      cfg = rows.length ? rows[0].valeur : {};
    }
    const campagne = (produit && cfg['camp_' + produit]) || cfg.camp_defaut;
    if (!campagne) {
      return res.status(400).json({ erreur: "Aucune campagne configurée — renseigne les IDs de campagnes Lemlist dans ⚙️ Envois (carte Connexion réelle)" });
    }

    let ownerEmail = null;
    if (sql && proprietaire) {
      const me = await sql`SELECT email_envoi FROM sdrs WHERE nom = ${proprietaire} LIMIT 1`;
      ownerEmail = me.length ? (me[0].email_envoi || null) : null;
    }

    const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64');
    const headers = { 'Content-Type': 'application/json', 'Authorization': auth };
    const urlEmail = `https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(contact.email)}`;
    const diag = {};

    // Corps du lead (variables perso de campagne) : on nettoie (drop vides + coerce chaîne)
    const brut = { firstName: contact.prenom || '', lastName: contact.nom || '', companyName: variables.companyName || '', ...variables, ...(ownerEmail ? { contactOwner: ownerEmail } : {}) };
    const corps = {};
    for (const [k, v] of Object.entries(brut)) {
      if (v === null || v === undefined || v === '') continue;
      corps[k] = (typeof v === 'string') ? v : (Array.isArray(v) ? v.join('; ') : String(v));
    }
    const { contactOwner, ...corpsMaj } = corps;

    // 1) Upsert du CONTACT (champs unifiés : se répercute sur toutes les campagnes)
    const contactBody = { email: contact.email };
    if (contact.prenom) contactBody.firstName = contact.prenom;
    if (contact.nom) contactBody.lastName = contact.nom;
    if (variables.companyName) contactBody.companyName = variables.companyName;
    if (variables.phone) contactBody.phone = variables.phone;
    if (variables.linkedinUrl) contactBody.linkedinUrl = variables.linkedinUrl;
    if (ownerEmail) contactBody.contactOwner = ownerEmail;
    try {
      const cr = await fetch('https://api.lemlist.com/api/contacts', { method: 'POST', headers, body: JSON.stringify(contactBody) });
      diag.contact = cr.status;
    } catch (e) { diag.contactErr = e.message; }

    // 2) Mettre à jour le lead dans la campagne, sinon l ajouter (déclenche la séquence)
    let maj = false, ajoute = false, data = {};
    let rep = await fetch(urlEmail, { method: 'PATCH', headers, body: JSON.stringify(corpsMaj) });
    let txt = await rep.text();
    diag.patchEmail = { status: rep.status, body: (txt || '').slice(0, 200) };
    if (rep.ok) { maj = true; try { data = JSON.parse(txt); } catch (_) {} }

    if (!maj) {
      rep = await fetch(urlEmail, { method: 'POST', headers, body: JSON.stringify(corps) });
      txt = await rep.text();
      diag.postEmail = { status: rep.status, body: (txt || '').slice(0, 200) };
      // Lemlist refuse le proprietaire (SDR pas reconnu comme utilisateur Lemlist) -> on ajoute le lead sans proprietaire
      if (!rep.ok && /owner/i.test(txt || '')) {
        rep = await fetch(urlEmail, { method: 'POST', headers, body: JSON.stringify(corpsMaj) });
        txt = await rep.text();
        diag.postSansOwner = { status: rep.status, body: (txt || '').slice(0, 200) };
      }
      if (rep.ok) { ajoute = true; try { data = JSON.parse(txt); } catch (_) {} }
    }

    // Filet : lead présent mais PATCH par email refusé → on récupère son id puis PATCH par id
    if (!maj && !ajoute) {
      try {
        const g = await fetch(`https://api.lemlist.com/api/leads/${encodeURIComponent(contact.email)}`, { headers });
        const gd = await g.json().catch(() => ({}));
        diag.lookup = g.status;
        if (g.ok && gd && gd._id) {
          const u = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(gd._id)}`, { method: 'PATCH', headers, body: JSON.stringify(corpsMaj) });
          diag.patchId = u.status;
          if (u.ok) { maj = true; }
        }
      } catch (e) { diag.lookupErr = e.message; }
    }

    if (!maj && !ajoute) {
      const dt = 'PATCH ' + diag.patchEmail.status + (diag.postEmail ? ' · POST ' + diag.postEmail.status + (diag.postEmail.body ? ': ' + diag.postEmail.body : '') : '') + (diag.patchId ? ' · PATCH#2 ' + diag.patchId : '');
      return res.status(502).json({ erreur: 'Lemlist a refusé le lead', detail: dt, diag });
    }

    // 3) Rappel J+5 + SMS J+7 : UNIQUEMENT au 1er ajout du lead (pas sur une simple mise à jour)
    if (ajoute) {
      try {
        const cle = contact.email;
        const ent = variables.companyName || '';
        const ctc = [contact.prenom, contact.nom].filter(Boolean).join(' ');
        const sdrTache = proprietaire || user.nom;
        if (sql && cle) {
          await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ref, ts)
            VALUES (${cle}, 'lemlist', 'sequenceAdded', ${'Ajoute a la sequence ' + (produit || 'Lemlist')}, ${ent || null}, ${sdrTache || null}, ${'add:' + cle + ':' + (produit || 'def')}, NOW())
            ON CONFLICT (ref) DO NOTHING`;
        }
        if (sql && cle && sdrTache) {
          const dej = await sql`SELECT id FROM taches WHERE sdr = ${sdrTache} AND fiche_cle = ${cle} AND faite = FALSE LIMIT 1`;
          if (!dej.length) {
            await sql`INSERT INTO taches (sdr, liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel)
              VALUES (${sdrTache}, ${liste_id || null}, ${cle}, ${ent || null}, ${ctc || null}, ${'Rappel - pas de reponse a la sequence ' + (produit || '')}, NOW() + INTERVAL '5 days')`;
          }
        }
        const smsTxt = (req.body && req.body.sms) || '';
        const tel = variables.phone || '';
        if (sql && produit === 'soreach' && tel && smsTxt.trim()) {
          const dejaSms = await sql`SELECT id FROM sms_programmes WHERE email = ${contact.email} AND statut = 'pending' LIMIT 1`;
          if (!dejaSms.length) {
            await sql`INSERT INTO sms_programmes (cle, liste_id, sdr, email, telephone, message, envoyer_le)
              VALUES (${cle}, ${liste_id || null}, ${sdrTache}, ${contact.email}, ${tel}, ${smsTxt.trim()}, NOW() + INTERVAL '7 days')`;
          }
        }
      } catch (e) { /* la programmation ne bloque pas l envoi */ }
    }

    return res.status(200).json({ ok: true, campagne, owner: ownerEmail, lead: data._id || contact.email, maj, ajoute, diag });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
