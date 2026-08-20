// /api/kb-visuels.js — 🖼 La bibliothèque d'images des présentations.
//
// Demande de Didier : « photo libre pour agrémenter la prez : photo de boutique pour des clients
// retail, photo automobile pour des garagistes… ». Un dossier de photos ne servirait à rien :
// pour qu'une image soit posée au bon endroit, il faut savoir CE QU'ELLE MONTRE. Chaque visuel
// entre donc avec une description et ses droits, exactement comme un bloc de connaissance entre
// avec sa source.
//
// GET                        → la liste avec les vignettes (léger)
// GET ?id=N                  → un visuel avec son image pleine
// GET ?pour=soview&secteur=… → les visuels utilisables, triés par pertinence (pour le générateur)
// POST { visuels: [...] }     → dépôt en lot, en proposition
// PUT  { id, action|champs }  → valider / refuser / corriger
// DELETE ?id=N               → archiver
//
// ⚠️ Deux champs sont obligatoires et refusés vides : la DESCRIPTION (sans elle l'IA place les
// images au hasard) et les DROITS (une photo de collaborateur sans accord, ou une image de banque
// sans licence, part chez un client au nom de Sofy).

import { verifierToken, sql } from './db.js';

export const config = { maxDuration: 60 };

export const TYPES_VISUEL = ['humain', 'ambiance', 'produit', 'client'];
const MODULES = ['soview', 'soconnect', 'soreach', 'tous'];
const MAX_IMAGE = 900_000;   // ~650 Ko de JPEG après compression navigateur
const MAX_VIGNETTE = 90_000;

let pret = false;
async function ensureVisuels() {
  if (pret || !sql) return;
  // Table paresseuse (jamais de bump de SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS kb_visuels (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    module TEXT NOT NULL DEFAULT 'tous',
    description TEXT NOT NULL,
    droits TEXT NOT NULL,
    secteur TEXT,
    image TEXT NOT NULL,
    vignette TEXT,
    largeur INTEGER, hauteur INTEGER, poids_ko INTEGER,
    statut TEXT DEFAULT 'propose',
    propose_par TEXT, valide_par TEXT, valide_le TIMESTAMPTZ, motif_refus TEXT,
    actif BOOLEAN DEFAULT TRUE,
    usages INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_visuels ON kb_visuels(statut, type) WHERE actif`;
  pret = true;
}

const estImage = v => /^data:image\/(jpeg|png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(String(v || ''));

// Un SVG est affiché dans une balise <img> : les scripts n'y sont pas exécutés. On refuse quand
// même ceux qui en contiennent — un fichier de logo n'a aucune raison d'embarquer du code.
function svgSain(dataUri) {
  if (!/^data:image\/svg\+xml/.test(String(dataUri))) return true;
  try {
    const txt = Buffer.from(String(dataUri).split(',')[1] || '', 'base64').toString('utf8').toLowerCase();
    return !/<script|onload=|onerror=|<foreignobject|javascript:/.test(txt);
  } catch (_) { return false; }
}

// Utilisée par le générateur et par l'éditeur : ne rend QUE les visuels validés, avec un score de
// pertinence. Le secteur du prospect pèse plus que le module : une photo de garage vaut mieux
// qu'une photo « Soview » générique quand on parle à un garagiste.
export async function visuelsUtilisables({ module, secteur } = {}) {
  await ensureVisuels();
  const rows = await sql`SELECT id, type, module, description, secteur, largeur, hauteur
    FROM kb_visuels WHERE actif AND statut = 'valide' ORDER BY type, id`;
  const mots = String(secteur || '').toLowerCase().split(/[^a-zà-ÿ]+/).filter(m => m.length > 3);
  return rows.map(r => {
    let score = 0;
    const s = String(r.secteur || '').toLowerCase();
    if (s && mots.some(m => s.includes(m))) score += 3;
    if (module && r.module === module) score += 2;
    if (r.module === 'tous') score += 1;
    return { ...r, score };
  }).sort((a, b) => b.score - a.score);
}

// La trame institutionnelle de la dernière planche : une photo d'équipe et les logos clients.
// Identique pour toutes les analyses — d'où l'intérêt de la lire ici plutôt que de la faire
// rédiger : aucun jeton dépensé, une seule version en circulation, et un logo se change en
// remplaçant un visuel dans la bibliothèque.
export async function visuelsInstit() {
  await ensureVisuels();
  const [eq] = await sql`SELECT image FROM kb_visuels
    WHERE actif AND statut = 'valide' AND type = 'humain'
    ORDER BY (description ILIKE '%équipe%' OR description ILIKE '%equipe%') DESC, id DESC LIMIT 1`;
  const clients = await sql`SELECT image, description FROM kb_visuels
    WHERE actif AND statut = 'valide' AND type = 'client' ORDER BY id LIMIT 30`;
  return { equipe: (eq && eq.image) || null, clients };
}

// Les images pleines des visuels réellement posés dans un document.
export async function imagesDe(ids) {
  await ensureVisuels();
  const liste = (ids || []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 20);
  if (!liste.length) return {};
  const rows = await sql`SELECT id, image, description FROM kb_visuels WHERE id = ANY(${liste})`;
  const out = {};
  for (const r of rows) out[r.id] = { image: r.image, description: r.description };
  return out;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureVisuels();
  const admin = ['admin', 'superadmin'].includes(user.role);

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.id) {
        const [r] = await sql`SELECT * FROM kb_visuels WHERE id = ${parseInt(q.id, 10) || 0}`;
        if (!r) return res.status(404).json({ erreur: 'Visuel introuvable' });
        return res.status(200).json({ ok: true, visuel: r });
      }
      if (q.pour || q.secteur) {
        return res.status(200).json({ ok: true, visuels: await visuelsUtilisables({ module: q.pour, secteur: q.secteur }) });
      }
      // Liste d'administration : vignettes seulement, pour que l'onglet reste léger
      const rows = await sql`SELECT id, type, module, description, droits, secteur, vignette,
          largeur, hauteur, poids_ko, statut, propose_par, valide_par, motif_refus, usages, created_at
        FROM kb_visuels WHERE actif ORDER BY
          CASE statut WHEN 'propose' THEN 0 WHEN 'valide' THEN 1 ELSE 2 END, id DESC`;
      return res.status(200).json({
        ok: true, visuels: rows, types: TYPES_VISUEL,
        en_attente: rows.filter(r => r.statut === 'propose').length,
        utilisables: rows.filter(r => r.statut === 'valide').length,
        poids_total_ko: rows.reduce((s, r) => s + (r.poids_ko || 0), 0)
      });
    }

    if (req.method === 'POST') {
      const lot = Array.isArray((req.body || {}).visuels) ? req.body.visuels : [];
      if (!lot.length) return res.status(400).json({ erreur: 'Aucun visuel reçu' });
      if (lot.length > 8) return res.status(400).json({ erreur: 'Huit visuels par envoi au maximum (limite de taille de requête)' });
      const ajoutes = [], refuses = [];
      for (const v of lot) {
        const nom = String(v.nom || 'sans nom').slice(0, 80);
        if (!estImage(v.image)) { refuses.push({ nom, motif: 'image illisible (JPEG, PNG, WebP ou SVG attendu)' }); continue; }
        if (!svgSain(v.image)) { refuses.push({ nom, motif: 'SVG contenant du code — exporte-le en PNG' }); continue; }
        if (String(v.image).length > MAX_IMAGE) { refuses.push({ nom, motif: 'image trop lourde après compression' }); continue; }
        if (v.vignette && String(v.vignette).length > MAX_VIGNETTE) { refuses.push({ nom, motif: 'vignette trop lourde' }); continue; }
        // Les deux refus qui protègent Sofy
        if (String(v.description || '').trim().length < 12) {
          refuses.push({ nom, motif: 'décris ce que montre l\'image — c\'est ce texte qui permet de la poser au bon endroit' }); continue;
        }
        if (String(v.droits || '').trim().length < 6) {
          refuses.push({ nom, motif: 'précise les droits (accord des personnes, licence de la banque d\'images)' }); continue;
        }
        const [row] = await sql`INSERT INTO kb_visuels
            (type, module, description, droits, secteur, image, vignette, largeur, hauteur, poids_ko, statut, propose_par)
          VALUES (${TYPES_VISUEL.includes(v.type) ? v.type : 'ambiance'},
                  ${MODULES.includes(v.module) ? v.module : 'tous'},
                  ${String(v.description).trim().slice(0, 500)}, ${String(v.droits).trim().slice(0, 300)},
                  ${v.secteur ? String(v.secteur).slice(0, 120) : null},
                  ${v.image}, ${v.vignette || null},
                  ${parseInt(v.largeur, 10) || null}, ${parseInt(v.hauteur, 10) || null},
                  ${parseInt(v.poids_ko, 10) || null},
                  ${admin ? 'valide' : 'propose'}, ${user.nom})
          RETURNING id, type, description`;
        ajoutes.push(row);
      }
      return res.status(200).json({
        ok: true, ajoutes, refuses,
        info: ajoutes.length
          ? `${ajoutes.length} visuel(s) ${admin ? 'ajouté(s) et disponible(s)' : 'proposé(s) — un admin les valide'}${refuses.length ? `, ${refuses.length} écarté(s)` : ''}.`
          : 'Aucun visuel n\'a pu être ajouté.'
      });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const id = parseInt(b.id, 10) || 0;
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      const [cur] = await sql`SELECT * FROM kb_visuels WHERE id = ${id}`;
      if (!cur) return res.status(404).json({ erreur: 'Visuel introuvable' });
      if (b.action) {
        if (!admin) return res.status(403).json({ erreur: 'Validation réservée aux admins' });
        if (b.action === 'valider') {
          await sql`UPDATE kb_visuels SET statut = 'valide', valide_par = ${user.nom}, valide_le = NOW(),
            motif_refus = NULL WHERE id = ${id}`;
          return res.status(200).json({ ok: true, info: 'Visuel validé — utilisable dans les analyses.' });
        }
        if (b.action === 'refuser') {
          await sql`UPDATE kb_visuels SET statut = 'refuse', motif_refus = ${String(b.motif || '').slice(0, 300)},
            valide_par = ${user.nom}, valide_le = NOW() WHERE id = ${id}`;
          return res.status(200).json({ ok: true, info: 'Visuel refusé.' });
        }
        return res.status(400).json({ erreur: 'action inconnue : valider | refuser' });
      }
      if (!admin && cur.propose_par !== user.nom) {
        return res.status(403).json({ erreur: 'Tu ne peux corriger que tes propres propositions.' });
      }
      const [row] = await sql`UPDATE kb_visuels SET
        description = COALESCE(${b.description ? String(b.description).slice(0, 500) : null}, description),
        droits = COALESCE(${b.droits ? String(b.droits).slice(0, 300) : null}, droits),
        secteur = COALESCE(${b.secteur !== undefined ? (String(b.secteur).slice(0, 120) || null) : null}, secteur),
        type = COALESCE(${TYPES_VISUEL.includes(b.type) ? b.type : null}, type),
        module = COALESCE(${MODULES.includes(b.module) ? b.module : null}, module)
        WHERE id = ${id} RETURNING id, type, description`;
      return res.status(200).json({ ok: true, visuel: row });
    }

    if (req.method === 'DELETE') {
      if (!admin) return res.status(403).json({ erreur: 'Réservé aux admins' });
      const id = parseInt((req.query || {}).id, 10) || 0;
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      // Archivage, pas suppression : un document déjà envoyé peut encore afficher cette image.
      await sql`UPDATE kb_visuels SET actif = FALSE WHERE id = ${id}`;
      return res.status(200).json({ ok: true, info: 'Visuel retiré de la bibliothèque (les documents déjà envoyés le conservent).' });
    }

    return res.status(405).json({ erreur: 'GET, POST, PUT ou DELETE' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Bibliothèque indisponible', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
