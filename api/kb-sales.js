// /api/kb-sales.js — 📚 Base de connaissance des présentations sales.
// C'est la pièce qui rend Didier autonome : il ajoute un cas client ou corrige un tarif, et la
// prochaine présentation générée s'en sert — sans modification de code.
//
// RÈGLE QUI PROTÈGE SOFY : l'IA n'a le droit d'écrire un chiffre que s'il vient soit des données
// MESURÉES du client (sa note Google, ses avis, ses établissements), soit d'un bloc de cette
// base AVEC sa source. Un « +30 % de CA » sans source ne doit jamais sortir d'un document qui
// porte le nom de Sofy.
//
// GET    ?module=&type=&tous=1   → blocs actifs (les périmés sont marqués, pas supprimés)
// POST   { …bloc }               → créer · { seed: true } → injecter le deck Sofy (idempotent)
// PUT    { id, … }               → modifier (met à jour verifie_le)
// DELETE ?id=N                   → désactiver (jamais de suppression : on garde la trace)

import { verifierToken, sql } from './db.js';

export const config = { maxDuration: 60 };

const TYPES = ['chiffre_marche', 'preuve', 'fonctionnalite', 'cas_client', 'objection', 'tarif', 'charte'];
const MODULES = ['soview', 'soconnect', 'soreach', 'tous'];
const TYPES_SENSIBLES = ['tarif', 'charte']; // engagent l'entreprise → admins seulement
const PEREMPTION_MOIS = 6; // au-delà, le bloc est signalé « à rafraîchir » et l'IA ne s'en sert plus

let kbPrete = false;
async function ensureKb() {
  if (kbPrete || !sql) return;
  // Table PARESSEUSE (pas de bump SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS kb_sales (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    module TEXT NOT NULL DEFAULT 'tous',
    titre TEXT NOT NULL,
    contenu TEXT NOT NULL,
    source TEXT,
    secteur TEXT,
    territoire TEXT,
    verifie_le DATE DEFAULT CURRENT_DATE,
    actif BOOLEAN DEFAULT TRUE,
    cle_seed TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  // Gouvernance : tout le monde propose, un admin (ou le CMO) valide. Seuls les blocs validés
  // sont servis au générateur — un chiffre non relu ne peut pas partir dans un document client.
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS statut TEXT DEFAULT 'propose'`;
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS propose_par TEXT`;
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS valide_par TEXT`;
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS valide_le TIMESTAMPTZ`;
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS motif_refus TEXT`;
  // L'URL publique du témoignage (interview Groupe Kiosque, Marimax…). Elle est SAISIE ICI, jamais
  // écrite par l'IA : un lien inventé dans un document client est indéfendable. La présentation
  // affiche alors un bouton « Lire l'interview » qui pointe dessus.
  await sql`ALTER TABLE kb_sales ADD COLUMN IF NOT EXISTS lien TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_sales_module ON kb_sales(module, type) WHERE actif`;
  kbPrete = true;
}

// ── Contenu de départ, extrait du deck « Sofy — Enjeux Visibilité & IA » (19 slides, 08/2026) ──
// Chaque bloc porte sa source telle qu'elle figure sur la slide : c'est ce qui autorise l'IA à
// réutiliser le chiffre dans un document client.
const SEED = [
  { cle_seed: 'deck1-recherche-categorie', type: 'chiffre_marche', module: 'soview',
    titre: '84 % des recherches portent sur une catégorie, pas sur votre nom',
    contenu: "84 % des recherches qui font découvrir une fiche Google portent sur une catégorie ou un service — pas sur le nom de l'enseigne. Autrement dit : l'entreprise est trouvée par des clients qui ne la connaissaient pas, à condition que sa fiche soit complète et bien catégorisée.",
    source: 'Étude sectorielle fiches Google · 2025 (deck Sofy « Enjeux Visibilité & IA », slide 2)' },
  { cle_seed: 'deck1-avis-google', type: 'chiffre_marche', module: 'soview',
    titre: '84 % des consommateurs consultent les avis Google avant de venir',
    contenu: "84 % des consommateurs utilisent Google pour consulter les avis d'une entreprise locale. Avant de pousser la porte, le client a déjà cherché, comparé et jugé en ligne.",
    source: 'Étude consommateurs locaux · 2025 (deck Sofy « Enjeux Visibilité & IA », slide 2)' },
  { cle_seed: 'deck1-reponse-avis-63', type: 'chiffre_marche', module: 'soview',
    titre: '63 % attendent une réponse à leur avis sous 2 à 7 jours',
    contenu: "63 % des consommateurs attendent une réponse à leur avis sous 2 à 7 jours. Répondre à tous les avis augmente fortement la confiance ; un avis laissé sans réponse est un signal négatif public.",
    source: 'Étude consommateurs locaux · 2025 (deck Sofy « Enjeux Visibilité & IA », slides 2 et 6)' },
  { cle_seed: 'deck1-cinq-dimensions', type: 'preuve', module: 'soview',
    titre: 'Les avis ne se subissent pas, ils se pilotent — les 5 dimensions',
    contenu: "**Le volume** : un flux régulier d'avis récents rassure davantage qu'un stock ancien, même flatteur. **La note** : premier filtre visuel, mais elle ne suffit plus à décider seule. **La fraîcheur** : un avis de moins de deux semaines pèse nettement plus lourd dans la décision. **La réponse** : 63 % des consommateurs l'attendent sous 2 à 7 jours. **Le contenu** : ce que les clients écrivent nourrit les mots-clés sur lesquels l'enseigne ressort — et ce que les IA racontent d'elle.",
    source: 'Deck Sofy « Enjeux Visibilité & IA », slide 6 (Levier 2 — Réputation)' },
  { cle_seed: 'deck1-nap', type: 'preuve', module: 'soview',
    titre: 'La cohérence NAP : la base que Google et les IA vérifient en premier',
    contenu: "**NAP = Name, Address, Phone.** Google, Apple Plans, Waze et les assistants IA croisent ces trois informations sur toutes les sources qu'ils trouvent. Dès qu'elles divergent — un ancien numéro sur un annuaire, une adresse écrite autrement, un horaire jamais mis à jour — le moteur perd confiance et déclasse la fiche au profit d'un concurrent dont les données concordent. À l'échelle d'un réseau, l'incohérence est la règle plutôt que l'exception : chaque point de vente a été renseigné par une personne différente, à une date différente. Sofy ramène tout à **une seule saisie diffusée partout**, et signale les divergences détectées.",
    source: 'Deck Sofy « Enjeux Visibilité & IA » — Levier 1 (Présence : fiches et cohérence des données)' },
  { cle_seed: 'deck1-store-locator', type: 'preuve', module: 'soview',
    titre: 'Store locator : une page par magasin, lisible par Google et par les IA',
    contenu: "**Une URL par établissement** : chaque point de vente devient une page indexable, avec ses horaires, ses avis et son itinéraire. **Données structurées Schema.org** : le balisage que les agents IA lisent en priorité — la même donnée que les fiches, sans divergence. **Maillage géographique** : ville, quartier, zone — le maillage qui fait sortir sur « près de moi ».",
    source: 'Deck Sofy « Enjeux Visibilité & IA », slide 10 (Le store locator)' },
  { cle_seed: 'deck1-prise-en-charge', type: 'fonctionnalite', module: 'soview',
    titre: 'Ce que Sofy prend en charge (les 5 engagements)',
    contenu: "**1. Vos fiches, à jour partout** — une seule saisie diffusée sur Google, Maps, Apple Plans, Waze, Facebook et Instagram. **2. Vos avis, collectés et traités** — invitations par SMS, QR code ou carte NFC ; réponses rédigées par Budy, validées par vous. **3. Budy, votre IA incluse** — réponses aux avis, suggestions de publication, analyse concurrentielle, sans surcoût. **4. Vos résultats, lisibles** — visibilité locale et comparaison avec les concurrents directs, sans tableau de bord illisible. **5. Un coach Sofy dédié** — un interlocuteur humain qui connaît votre réseau, inclus, sans option payante.",
    source: 'Deck Sofy « Enjeux Visibilité & IA », slide 16' },
  { cle_seed: 'deck1-audit-seo', type: 'fonctionnalite', module: 'soview',
    titre: 'Audit SEO Soview : un score sur 100 par établissement et par pilier',
    contenu: "L'audit note chaque établissement sur 100 et détaille quatre piliers : profil, avis, posts, médias. Il produit une synthèse de groupe (score moyen, meilleur et moins bon établissement) et pointe les lacunes structurelles qui freinent la visibilité — par exemple une note parfaite mais aucune adresse physique renseignée et aucune actualité publiée.",
    source: 'Deck Sofy « Enjeux Visibilité & IA », slide 16 (capture produit Audit SEO)' },
  // ── Mécanismes produit, relevés sur les captures de l'app (dossier « fichiers pour pitch deck
  // sales », 19/08). Ces blocs existent parce que la première analyse générée décrivait les
  // modules par leur nom sans jamais dire COMMENT ils produisent un résultat : illisible pour un
  // directeur marketing, qui achète un mécanisme, pas un logo.
  { cle_seed: 'meca-collecte-avis', type: 'fonctionnalite', module: 'soview',
    titre: 'Comment une note remonte : collecte à chaud par SMS ou RCS',
    contenu: "L'invitation part **automatiquement après le passage en caisse ou la livraison**, par SMS ou par RCS, avec le nom du client et de l'établissement. Le client tape sur **« Laisser un avis »** et note sans quitter sa messagerie — pas de compte à créer, pas d'application à installer. Trois effets qui se cumulent : le **volume** augmente, la **fraîcheur** aussi (un avis de moins de deux semaines pèse plus lourd), et la note remonte mécaniquement parce qu'on interroge tous les clients satisfaits, pas seulement les mécontents qui écrivent d'eux-mêmes.",
    source: 'Produit Soview — module « Récolter des avis » (canal SMS/RCS, expéditeur, message personnalisé)' },
  { cle_seed: 'meca-budy-reponses', type: 'fonctionnalite', module: 'soview',
    titre: 'Budy répond aux avis à votre place, vous validez',
    contenu: "L'IA **Budy** lit chaque avis, en fait la synthèse et rédige la réponse dans le ton de l'enseigne. Vous validez d'un clic, ou vous corrigez. C'est ce qui rend tenable l'objectif de **réponse sous 24 à 48 heures** sur un réseau entier — le seul délai qui compte, puisque 63 % des consommateurs attendent une réponse sous 2 à 7 jours. Budy est **incluse**, sans surcoût ni option.",
    source: 'Produit Soview — écran Avis : résumé IA des avis et réponses suggérées (badge « Répondu sous 24h »)' },
  { cle_seed: 'meca-audit-analyse', type: 'fonctionnalite', module: 'soview',
    titre: 'Vous voyez votre position réelle face à vos concurrents, pas une impression',
    contenu: "**Analyse marché** : pour une recherche et une zone données, Sofy établit votre position (ex : 10ᵉ, en recul de 2 rangs), le niveau de compétitivité du marché, un **verdict explicite** (« vigilance requise ») et ce qui explique l'écart avec les concurrents mieux classés. **Audit SEO** : chaque établissement est noté **sur 100** sur quatre piliers — profil, avis, publications, médias — avec la synthèse du réseau et le nom du point de vente qui décroche. C'est le tableau de bord qui remplace les suppositions.",
    source: 'Produit Soview — écrans « Analyse marché » et « Audit SEO » (score /100 par établissement)' },
  { cle_seed: 'meca-soconnect-canaux', type: 'fonctionnalite', module: 'soconnect',
    titre: 'Toutes les conversations clients dans une seule boîte',
    contenu: "Instagram, Facebook, WhatsApp, Messenger, Google Business et le téléphone arrivent dans **une seule interface**, avec l'historique du client et le contexte de sa commande. Budy pré-qualifie et propose la réponse. Effet mesuré chez un client : **temps de réponse divisé par deux** (30 min → 10-15 min) sur 150 demandes par jour, et un objectif de call center dépassé de 30 %.",
    source: 'Produit SoConnect + interview client Marimax publiée sur le blog Sofy' },
  { cle_seed: 'meca-soreach-rcs', type: 'fonctionnalite', module: 'soreach',
    titre: 'RCS : le SMS avec votre marque, votre logo et un bouton',
    contenu: "Le **RCS** affiche le nom vérifié de l'enseigne, son logo, une image et des **boutons cliquables** — là où un SMS classique montre un numéro court anonyme. Le client reconnaît l'expéditeur avant d'ouvrir. Bascule automatique en SMS quand le téléphone ne prend pas le RCS : aucun message perdu. Mesuré chez un client sur campagne SMS : **85,7 % d'ouverture et 47,1 % de clic**.",
    source: 'Produit SoReach + interview client Groupe Kiosque publiée sur le blog Sofy' },
  { cle_seed: 'meca-deploiement', type: 'preuve', module: 'tous',
    titre: 'Ce qui se passe les 90 premiers jours',
    contenu: "**Semaines 1-2 — état des lieux** : audit de vos fiches, score sur 100 par établissement, divergences NAP relevées, priorisation des points de vente qui pèsent le plus sur la moyenne. **Semaines 3-6 — mise en ordre** : fiches corrigées et diffusées partout depuis une seule saisie, store locator branché, collecte d'avis activée sur les premiers sites. **Semaines 7-12 — régime de croisière** : réponses sous 24-48 h avec Budy, extension au reste du réseau, suivi de la note et de la position concurrentielle. Un **coach Sofy dédié** suit le déploiement, inclus.",
    source: 'Méthode de déploiement Sofy — à confirmer avec le Customer Success avant tout engagement de délai' },
  // Cas clients — interviews publiées sur le blog Sofy, donc citables publiquement (accord
  // Didier 19/08). Le secteur et le territoire servent au générateur à choisir le cas le plus
  // proche du prospect : un garage guadeloupéen doit lire Marimax, pas un réseau télécom.
  { cle_seed: 'cas-marimax', type: 'cas_client', module: 'soconnect',
    titre: 'Marimax — 150 demandes par jour, objectif du call center dépassé de 30 %',
    secteur: 'distribution de pièces détachées automobiles', territoire: 'Guadeloupe',
    contenu: "Distributeur de pièces auto, 2 sites (Baie-Mahault et Pointe-à-Pitre). **Avant :** 150 demandes par jour éclatées sur 5 canaux (Instagram, Facebook, WhatsApp, Messenger, téléphone), des délais de réponse qui s'allongeaient, des opportunités commerciales perdues, une réputation locale peu exploitée (60 à 70 avis) et des données clients dispersées. **Modules :** SoConnect, Soview, SoReach. **Résultats :** temps de réponse divisé par deux (30 min → 10-15 min) · objectif du call center dépassé de +30 % · plus de 500 avis Google collectés dont 329 avis 5 étoiles · note Google passée de 3,4/5 en 2023 à 4,25/5 en 2026 · 20 000 leads qualifiés en base · plus de 140 000 SMS envoyés en 2025 · chiffre d'affaires commercial doublé entre 2023 et 2025. **Verbatim client :** « Sofy est la seule interface qui regroupait tout ce dont on avait besoin. »",
    source: 'Interview client publiée sur le blog Sofy — sofy.fr/articles-de-blog/150-demandes-par-jour-et-un-objectif-du-call-center-depasse-de-30' },
  { cle_seed: 'cas-groupe-kiosque', type: 'cas_client', module: 'soview',
    titre: 'Groupe Kiosque — 32 points de vente, 4 territoires, 436 avis en 6 mois',
    secteur: 'télécommunications et services numériques', territoire: 'Martinique, Guadeloupe, Guyane, Burkina Faso',
    contenu: "Réseau de 32 établissements sur 4 territoires. **Avant :** 32 fiches Google Business gérées séparément, aucune vision centralisée de l'e-réputation, campagnes mobiles peu coordonnées entre établissements, temps de gestion important et analyse manuelle imprécise. **Modules :** Soview et SoReach SMS (SoConnect prévu). **Résultats en 6 mois :** 436 avis Google collectés · notes d'établissement jusqu'à 4,9/5 · réponse aux avis en 24 heures maximum · campagnes SMS à 85,7 % d'ouverture et 47,14 % de clic · base de contacts centralisée de plus de 11 000 contacts. **Verbatim client :** « La relation client est excellente. Les équipes sont accessibles, réactives et nous accompagnent aussi bien sur la prise en main que sur des problématiques spécifiques. »",
    source: 'Interview client publiée sur le blog Sofy — sofy.fr/articles-de-blog/comment-le-groupe-kiosque-pilote-sa-visibilite-locale-et-son-e-reputation-sur-32-points-de-vente-et-4-territoires-g2835' },
  { cle_seed: 'tarifs-2026-08', type: 'tarif', module: 'tous',
    titre: 'Grille tarifaire de référence',
    contenu: "Soview à partir de 440 €/mois par établissement. SoConnect 319 €/mois. Frais d'installation et de configuration facturés séparément selon le périmètre.",
    source: 'Grille commerciale interne · relevée sur facturation Zoho 08/2026 — à confirmer avant toute mention chiffrée dans un document client' },
  { cle_seed: 'charte-deck-sofy', type: 'charte', module: 'tous',
    titre: 'Charte visuelle des présentations Sofy',
    contenu: "Deux fonds alternés : **clair** (dégradé blanc vers lavande et rose très pâle) et **sombre** (bleu nuit #0F0B29 vers violet profond). Accent : dégradé violet #5B4FE9 vers rose #F0428A, appliqué sur un segment du titre et sur le trait qui le souligne. Structure de chaque planche : logo sofy en haut à gauche, pagination « 05 / 19 » en haut à droite, eyebrow en petites capitales espacées et colorée, titre géant gras sur deux lignes, trait dégradé, sous-titre gris, puis le contenu. Cartes blanches à ombre douce sur fond clair, bleu nuit translucide à fine bordure sur fond sombre. Listes numérotées en pastilles dégradées. Chiffres géants en violet avec leur source en petit gris juste dessous. Captures produit présentées dans un cadre de navigateur. Pied de page : « sofy.fr » à gauche, nom de la section à droite.",
    source: 'Deck Sofy « Enjeux Visibilité & IA » (19 slides, 08/2026) — référence de style pour toute présentation générée' }
];

// Amorçage du contenu du deck Sofy. Idempotent (cle_seed unique) → relançable sans doublon et
// sans écraser une correction faite à la main. Exporté parce que le générateur l'appelle tout
// seul quand la base est vide : demander une requête technique à un SDR n'est pas une option.
// Réutilisés par /api/kb-ingest : les types et modules ne doivent exister qu'à un seul endroit.
export const TYPES_KB = TYPES;
export const MODULES_KB = MODULES;
export const ensureKbPublique = ensureKb;

export async function amorcer(par) {
  await ensureKb();
  let ajoutes = 0, remis = 0;
  for (const s of SEED) {
    // ON CONFLICT DO NOTHING ne suffisait pas : les blocs insérés AVANT l'ajout de la gouvernance
    // ont reçu le défaut de la colonne (`statut = 'propose'`) quand l'ALTER TABLE est passé. Ils
    // existaient donc en base, invisibles pour le générateur, et l'amorçage les ignorait —
    // « base vide malgré l'amorçage ». On les remet à l'état officiel, sans jamais écraser le
    // texte : une correction faite à la main sur titre/contenu/source est préservée.
    const r = await sql`INSERT INTO kb_sales
        (type, module, titre, contenu, source, secteur, territoire, cle_seed, verifie_le, actif, statut, valide_par, valide_le)
      VALUES (${s.type}, ${s.module}, ${s.titre}, ${s.contenu}, ${s.source}, ${s.secteur || null},
              ${s.territoire || null}, ${s.cle_seed}, CURRENT_DATE, TRUE, 'valide', ${par || 'amorçage Sofy'}, NOW())
      ON CONFLICT (cle_seed) DO UPDATE SET
        statut = 'valide',
        actif = TRUE,
        motif_refus = NULL,
        secteur = COALESCE(kb_sales.secteur, EXCLUDED.secteur),
        territoire = COALESCE(kb_sales.territoire, EXCLUDED.territoire),
        verifie_le = GREATEST(kb_sales.verifie_le, CURRENT_DATE),
        valide_par = COALESCE(kb_sales.valide_par, EXCLUDED.valide_par),
        valide_le = COALESCE(kb_sales.valide_le, NOW())
      RETURNING id, (xmax = 0) AS cree`;
    if (r.length && r[0].cree) ajoutes++;
    else if (r.length) remis++;
  }
  return { ajoutes, remis, total: SEED.length };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureKb();
  const admin = ['admin', 'superadmin'].includes(user.role);

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const rows = await sql`SELECT * FROM kb_sales
        WHERE (${q.tous === '1'} OR actif)
          AND (${q.module || ''} = '' OR module = ${q.module || ''} OR module = 'tous')
          AND (${q.type || ''} = '' OR type = ${q.type || ''})
        ORDER BY type, module, id`;
      const perime = r => r.verifie_le &&
        (Date.now() - new Date(r.verifie_le).getTime()) > PEREMPTION_MOIS * 30 * 86400000;
      const blocs = rows.map(r => ({ ...r, perime: !!perime(r) }));
      return res.status(200).json({
        ok: true, blocs, total: blocs.length,
        a_rafraichir: blocs.filter(b => b.perime).length,
        en_attente: blocs.filter(b => b.statut === 'propose').length,
        utilisables: blocs.filter(b => b.statut === 'valide' && !b.perime).length,
        peremption_mois: PEREMPTION_MOIS, types: TYPES, modules: MODULES
      });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      // L'amorçage et les types sensibles restent admin ; la contribution ordinaire est ouverte
      // aux SDR et aux AE : ce sont eux qui rencontrent les objections et les cas terrain.
      if ((b.seed || TYPES_SENSIBLES.includes(b.type)) && !admin) {
        return res.status(403).json({ erreur: b.seed ? 'Amorçage réservé aux admins' : `Le type « ${b.type} » engage l'entreprise : seul un admin peut l'ajouter.` });
      }

      // Amorçage : injecte le contenu du deck Sofy. Idempotent (cle_seed unique) → relançable
      // sans créer de doublons, et sans écraser une correction faite à la main.
      if (b.seed) {
        const r = await amorcer(user.nom);
        return res.status(200).json({
          ok: true, ...r,
          info: [r.ajoutes ? `${r.ajoutes} bloc(s) ajouté(s)` : null,
                 r.remis ? `${r.remis} bloc(s) remis à l'état validé` : null].filter(Boolean).join(' · ')
                || 'Tous les blocs du deck étaient déjà en place — rien écrasé.'
        });
      }

      if (!b.titre || !b.contenu) return res.status(400).json({ erreur: 'titre et contenu requis' });
      if (!TYPES.includes(b.type)) return res.status(400).json({ erreur: 'type invalide : ' + TYPES.join(', ') });
      // Un chiffre de marché ou un cas client sans source ne doit pas entrer : c'est exactement
      // ce que l'IA irait recopier dans un document qui sort de l'entreprise.
      if (['chiffre_marche', 'cas_client'].includes(b.type) && !String(b.source || '').trim()) {
        return res.status(400).json({ erreur: 'Une source est obligatoire pour un chiffre de marché ou un cas client — sans elle, l\'IA ne pourra pas le citer.' });
      }
      // Un admin (ou le CMO) valide directement ce qu'il ajoute ; un SDR/AE propose.
      const statut = admin ? 'valide' : 'propose';
      const lien = lienSain(b.lien);
      if (b.lien && !lien) return res.status(400).json({ erreur: 'Le lien doit être une adresse http(s) complète — c\'est elle qui sera cliquée par le prospect.' });
      const [row] = await sql`INSERT INTO kb_sales (type, module, titre, contenu, source, secteur, territoire,
          verifie_le, statut, propose_par, valide_par, valide_le, lien)
        VALUES (${b.type}, ${MODULES.includes(b.module) ? b.module : 'tous'}, ${b.titre}, ${b.contenu},
                ${b.source || null}, ${b.secteur || null}, ${b.territoire || null}, CURRENT_DATE,
                ${statut}, ${user.nom}, ${admin ? user.nom : null}, ${admin ? new Date().toISOString() : null},
                ${lien}) RETURNING *`;
      return res.status(200).json({
        ok: true, bloc: row,
        info: admin ? 'Bloc ajouté et validé — utilisable dès la prochaine présentation.'
                    : 'Bloc proposé. Il sera utilisé par l\'IA dès qu\'un admin l\'aura validé.'
      });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ erreur: 'id requis' });
      const [avant] = await sql`SELECT * FROM kb_sales WHERE id = ${parseInt(b.id)}`;
      if (!avant) return res.status(404).json({ erreur: 'Bloc introuvable' });
      // Un contributeur peut corriger SA proposition tant qu'elle n'est pas validée
      if (!admin && !(avant.statut === 'propose' && avant.propose_par === user.nom)) {
        return res.status(403).json({ erreur: 'Tu ne peux modifier que tes propres propositions non encore validées.' });
      }
      // Validation / refus : admin uniquement
      if (b.action && admin) {
        if (b.action === 'valider') {
          const [v] = await sql`UPDATE kb_sales SET statut = 'valide', valide_par = ${user.nom}, valide_le = NOW(),
            motif_refus = NULL, verifie_le = CURRENT_DATE WHERE id = ${parseInt(b.id)} RETURNING *`;
          return res.status(200).json({ ok: true, bloc: v, info: 'Validé — l\'IA peut désormais s\'en servir.' });
        }
        if (b.action === 'refuser') {
          const [v] = await sql`UPDATE kb_sales SET statut = 'refuse', motif_refus = ${String(b.motif || '').slice(0, 300)},
            valide_par = ${user.nom}, valide_le = NOW() WHERE id = ${parseInt(b.id)} RETURNING *`;
          return res.status(200).json({ ok: true, bloc: v, info: 'Refusé — le bloc reste visible avec son motif, pour que le contributeur comprenne.' });
        }
        return res.status(400).json({ erreur: 'action inconnue : valider | refuser' });
      }
      if (b.action && !admin) return res.status(403).json({ erreur: 'Validation réservée aux admins' });
      // Toute modification remet la date de vérification à aujourd'hui : c'est le geste qui
      // sort un bloc de l'état « à rafraîchir ».
      const [row] = await sql`UPDATE kb_sales SET
        titre = COALESCE(${b.titre || null}, titre),
        contenu = COALESCE(${b.contenu || null}, contenu),
        source = COALESCE(${b.source || null}, source),
        module = COALESCE(${MODULES.includes(b.module) ? b.module : null}, module),
        secteur = COALESCE(${b.secteur || null}, secteur),
        territoire = COALESCE(${b.territoire || null}, territoire),
        actif = COALESCE(${typeof b.actif === 'boolean' ? b.actif : null}, actif),
        lien = COALESCE(${lienSain(b.lien)}, lien),
        verifie_le = CURRENT_DATE
        WHERE id = ${parseInt(b.id)} RETURNING *`;
      if (!row) return res.status(404).json({ erreur: 'Bloc introuvable' });
      return res.status(200).json({ ok: true, bloc: row });
    }

    if (req.method === 'DELETE') {
      if (!admin) return res.status(403).json({ erreur: 'Réservé aux admins' });
      const id = parseInt((req.query || {}).id);
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      // Désactivation, jamais suppression : on garde la trace de ce qui a servi aux présentations
      await sql`UPDATE kb_sales SET actif = FALSE WHERE id = ${id}`;
      return res.status(200).json({ ok: true, desactive: id });
    }

    return res.status(405).json({ erreur: 'GET, POST, PUT ou DELETE' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Base de connaissance indisponible', detail: String((e && e.message) || e).slice(0, 250) });
  }
}

// Utilisé par le générateur de présentations : ne renvoie que les blocs utilisables
// (actifs et non périmés) pour un module donné.
// Une URL de témoignage ne part dans un document client que si elle est en http(s) : un
// « javascript: » ou un « data: » cliqué par un prospect serait une faille signée Sofy.
export const lienSain = (u) => {
  const v = String(u || '').trim();
  if (!v) return null;
  try { const x = new URL(v); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : null; }
  catch (_) { return null; }
};

export async function blocsUtilisables(module) {
  await ensureKb();
  const rows = await sql`SELECT id, type, module, titre, contenu, source, secteur, territoire, verifie_le, lien
    FROM kb_sales WHERE actif AND statut = 'valide' AND (module = ${module || 'tous'} OR module = 'tous')
      AND verifie_le > CURRENT_DATE - (${PEREMPTION_MOIS} || ' months')::interval
    ORDER BY type, id`;
  return rows;
}
