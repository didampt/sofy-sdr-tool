// /api/veille.js — Veille signaux LinkedIn (PhantomBuster) sur les listes 🔔
// Appelée automatiquement par le cron Vercel (toutes les 6 h) ou manuellement par le superadmin.
//
// Variables Vercel nécessaires :
//   PHANTOMBUSTER_API_KEY    → ta clé API PhantomBuster
//   PHANTOMBUSTER_AGENT_IDS  → IDs des Phantoms à surveiller, séparés par des virgules (ex: "1234567,7654321")
//                              (Phantoms type "LinkedIn Post Likers" / "Company Followers" programmés côté PB)
//   SLACK_WEBHOOK_URL        → webhook du canal Slack des SDR
//   CRON_SECRET              → secret du cron Vercel (généré automatiquement quand la variable existe)
//
// Logique : pour chaque Phantom → résultat le plus récent → on compare avec les profils déjà vus
// (table veille_etat) → les NOUVEAUX likers sont croisés avec les contacts des listes en veille
// (match par URL LinkedIn) → signal 🔥 sur la fiche + ligne dans la table signaux + alerte Slack.

import { sql, ensureSchema, verifierToken , ajouterHotLead } from './db.js';

export const config = { maxDuration: 120 };

function normaliserLinkedin(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/linkedin\.com\/(in|company)\/([^/?#]+)/);
  return m ? `${m[1]}/${decodeURIComponent(m[2]).replace(/\/$/, '')}` : null;
}

function normaliserNom(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extraireProfils(data) {
  // Les exports PhantomBuster varient selon le Phantom : on cherche toute URL LinkedIn /in/ ou /company/
  // ⚠️ Post Likers renvoie des URLs cryptées (/in/ACoAA…) ≠ URLs lisibles de Dropcontact → le match
  // se fait aussi PAR NOM (prénom+nom normalisés). La clé de dédup est memberId quand présent.
  const profils = [];
  const lignes = Array.isArray(data) ? data : (data && Array.isArray(data.result) ? data.result : []);
  for (const ligne of lignes) {
    if (!ligne || typeof ligne !== 'object') continue;
    let url = null, nom = null, occupation = null, post = null, memberId = null, reaction = null, commentaire = null;
    for (const [k, v] of Object.entries(ligne)) {
      const kl = k.toLowerCase();
      if (typeof v === 'string') {
        if (!url && /linkedin\.com\/(in|company)\//i.test(v) && !kl.includes('post')) url = v;
        if (!post && kl.includes('post') && /linkedin\.com/i.test(v)) post = v;
        if (!nom && (kl === 'name' || kl === 'fullname' || kl === 'full_name' || kl === 'profilename')) nom = v;
        if (!occupation && (kl === 'occupation' || kl === 'title' || kl === 'headline' || kl === 'job')) occupation = v;
        if (!reaction && kl === 'reactiontype') reaction = v;
        if (!commentaire && (kl === 'comment' || kl === 'commenttext' || kl === 'commentcontent')) commentaire = v;
      }
      if ((kl === 'memberid' || kl === 'membre_id') && v) memberId = String(v);
    }
    if (url || nom) profils.push({
      url: normaliserLinkedin(url), brut: url || '', nom: nom || '', nomNorm: normaliserNom(nom),
      occupation: occupation || '', post: post || '', reaction: reaction || '', commentaire: commentaire || '',
      cle: memberId || normaliserLinkedin(url) || normaliserNom(nom)
    });
  }
  return profils.filter(p => p.cle);
}

// Détermine le type d'interaction (like / commentaire / follow) à partir du nom du Phantom + des champs
// Extrait le nom de la société depuis l'occupation LinkedIn
// Ex: "Chief Marketing Officer@Splio" → "Splio" ; "Ecosystem Builder @ Splio | AI-First CRM" → "Splio"
function extraireSociete(occupation) {
  if (!occupation) return '';
  let s = occupation;
  // Après le @ (séparateur titre@société)
  if (s.includes('@')) s = s.split('@')[1];
  // Sinon après "chez" / "at"
  else if (/\b(chez|at)\b/i.test(s)) s = s.split(/\b(?:chez|at)\b/i)[1] || '';
  else return ''; // pas de séparateur fiable → on ne devine pas
  // Coupe aux séparateurs courants (| , - •) et nettoie
  s = (s || '').split(/[|•\u2022,]/)[0].replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 60 ? s : '';
}

// Extrait le nom du concurrent depuis l'URL du post LinkedIn (ex: /posts/partoo_... → Partoo)
function extraireConcurrent(post) {
  if (!post) return '';
  // Format LinkedIn : linkedin.com/posts/<slug>_... ou /company/<slug>/
  let m = post.match(/\/posts\/([a-z0-9\-]+?)[_\/]/i) || post.match(/\/company\/([a-z0-9\-]+)/i) || post.match(/\/in\/([a-z0-9\-]+)/i);
  if (!m) return '';
  // Nettoie : enlève les suffixes activity/tirets, capitalise
  let nom = m[1].replace(/-\d+$/, '').replace(/-/g, ' ').trim();
  return nom.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function typerSignal(nomAgent, p) {
  const n = (nomAgent || '').toLowerCase();
  const r = (p.reaction || '').toLowerCase();
  // Follow : Phantom "Company Follower"
  if (n.includes('follow')) return { emoji: '➕', label: 'suit la page', verbe: 'suit' };
  // Commentaire : Phantom "Commenter" ou champ commentaire présent
  if (n.includes('comment') || p.commentaire) return { emoji: '💬', label: 'a commenté', verbe: 'a commenté' };
  // Like / réaction : Phantom "Post Likers" (cas par défaut des posts)
  const react = { like: '👍 a liké', praise: '👏 a applaudi', empathy: '❤️ a soutenu', interest: '💡 intéressé', appreciation: '👏 a apprécié', maybe: '🤔 curieux', funny: '😄 a ri' };
  if (r && react[r]) return { emoji: '💙', label: react[r], verbe: react[r] };
  return { emoji: '💙', label: 'a liké', verbe: 'a réagi' };
}

async function envoyerSlack(texte) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texte }) });
  } catch (_) {}
}

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  // Accès : cron Vercel (en-tête x-vercel-cron natif, comme tous les autres crons — l'ancien
  // Bearer CRON_SECRET exigeait une variable absente : 401 silencieux toutes les 6 h, veille
  // jamais exécutée automatiquement) OU superadmin connecté (bouton "Tester la veille")
  const auth = req.headers.authorization || '';
  const estCron = !!req.headers['x-vercel-cron'] || (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`);
  const user = verifierToken(req);
  if (!estCron && (!user || user.role !== 'superadmin')) {
    return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
  }

  const pbKey = process.env.PHANTOMBUSTER_API_KEY;
  const agentIds = (process.env.PHANTOMBUSTER_AGENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  // L'import manuel (POST) fonctionne SANS PhantomBuster — la garde ne bloque que le chemin cron
  if (req.method !== 'POST' && (!pbKey || !agentIds.length)) {
    return res.status(200).json({ ok: false, message: 'PHANTOMBUSTER_API_KEY ou PHANTOMBUSTER_AGENT_IDS manquante — veille PB inactive (l’import manuel reste disponible)' });
  }

  try {
    // ── 1. Listes en veille active + index des contacts par URL LinkedIn ──
    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE veille = TRUE AND (veille_fin IS NULL OR veille_fin > NOW())`;
    const index = new Map();     // linkedin normalisé → match
    const indexNoms = new Map(); // "prenom nom" normalisé → match (repli : les Phantoms renvoient des URLs cryptées)
    for (const l of listes) {
      (l.entreprises || []).forEach((e, ei) => {
        (e.contacts || []).forEach((c, ci) => {
          const m = { liste: l, ei, ci, entreprise: e.enseigne_ia || e.enseigne || e.nom, contact: `${c.prenom || ''} ${c.nom || ''}`.trim() };
          const url = normaliserLinkedin(c.enrich && c.enrich.linkedin);
          if (url) index.set(url, m);
          const nomCle = normaliserNom(`${c.prenom || ''} ${c.nom || ''}`);
          if (nomCle && nomCle.includes(' ')) indexNoms.set(nomCle, m);
        });
        // Page entreprise LinkedIn (suivie par les Phantoms "followers")
        const pageCo = normaliserLinkedin(e.linkedin_entreprise);
        if (pageCo) index.set(pageCo, { liste: l, ei, ci: -1, entreprise: e.enseigne_ia || e.enseigne || e.nom, contact: '' });
      });
    }

    const resume = { agents: 0, nouveaux: 0, matches: 0, listes_en_veille: listes.length };
    const aSauver = new Map(); // liste_id → entreprises modifiées

    // ══ MODE IMPORT MANUEL (POST — remplaçant de PhantomBuster, 05/08) ══
    // Le superadmin colle les likers d'un post (le sien OU un post concurrent) : texte brut
    // copié depuis la fenêtre des réactions LinkedIn, ou JSON [{nom,url,occupation}] produit
    // par le mini-extracteur console. Même pipeline : dédup (veille_etat 'import'), croisement
    // par URL/nom, signal 🔥 + Slack, non-matchés → Hot Leads. Alerte dès le 1er import.
    if (req.method === 'POST') {
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Import réservé au superadmin' });
      const body = req.body || {};
      const source = String(body.source || 'likers importés').slice(0, 80);
      // URL du post (champ dédié, repli : URL trouvée dans la source) → lien 🔗 sur la fiche,
      // dérivation de l'entreprise auteure, accroche IA si le texte du post est fourni
      const postUrl = String(body.post_url || (String(body.source || '').match(/https?:\/\/\S+/) || [])[0] || '').slice(0, 300) || null;
      const postTexte = String(body.post_texte || '').slice(0, 1200);
      let arr = Array.isArray(body.profils) ? body.profils : null;
      const txt = String(body.texte || '').trim();
      if (!arr && txt.startsWith('[')) { try { arr = JSON.parse(txt); } catch (_) {} }
      if (!arr) {
        arr = [];
        const lignes = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const bruit = /^(voir le profil|se connecter|suivre|message|réagir|réactions?|j['’]aime|celebrate|love|insightful|funny|support|premium|membre de linkedin|statut|toutes?|tous|et \d+|plus|\d+([ .]\d+)*)$/i;
        const ressembleFonction = /(chez|at |@| [-–|] |direct(eur|rice)|responsable|manager|g[ée]rant|ceo|founder|fondat|consultant|commercial|marketing|dirigeant|pr[ée]sident|charg[ée])/i;
        for (let i = 0; i < lignes.length; i++) {
          const l = lignes[i].replace(/\s*·.*$/, '').replace(/\s*(1er|2e|3e\+?)\s*$/i, '').trim();
          if (!l || l.length < 4 || l.length > 60 || bruit.test(l) || ressembleFonction.test(l)) continue;
          const mots = l.split(/\s+/);
          if (mots.length < 2 || mots.length > 5) continue;
          const next = lignes[i + 1] || '';
          arr.push({ nom: l, occupation: ressembleFonction.test(next) ? next.slice(0, 120) : '' });
        }
      }
      const profilsImp = (arr || []).map(p => {
        const brut = p.url || p.linkedin || null;
        const url = normaliserLinkedin(brut);
        const nom = String(p.nom || '').replace(/\s*·.*$/, '').trim();
        return { cle: url || normaliserNom(nom), url, nom, nomNorm: normaliserNom(nom), occupation: p.occupation || '', post: source, brut };
      }).filter(p => p.cle && p.nom && p.nomNorm.includes(' '));
      if (!profilsImp.length) return res.status(400).json({ erreur: 'Aucun profil reconnu dans le texte collé — copie la liste depuis la fenêtre des réactions LinkedIn (noms + fonctions)' });

      const etatI = await sql`SELECT deja_vus FROM veille_etat WHERE cle = 'import'`;
      const dejaVusI = new Set(etatI.length ? etatI[0].deja_vus : []);
      const forcerI = req.body && req.body.forcer === true; // ♻️ repêchage : ré-analyse aussi les déjà vus
      const nouveauxI = forcerI ? profilsImp : profilsImp.filter(p => !dejaVusI.has(p.cle));
      // Seuls les profils GARDÉS (hot lead créé/déjà présent, ou match liste en veille) sont marqués
      // « vus » — les exclus du filtre restent repêchables si le filtre s'améliore (cas Justine T., 05/08).
      const clesVuesI = [];

      const cfgRowsHL = await sql`SELECT valeur FROM config WHERE cle = 'hotleads'`;
      const cfgHL = cfgRowsHL.length ? cfgRowsHL[0].valeur : {};
      const cfgRowsC = await sql`SELECT valeur FROM config WHERE cle = 'concurrents'`;
      const cfgC = cfgRowsC.length ? cfgRowsC[0].valeur : {};
      const CONCS = [...(cfgC.soview || []), ...(cfgC.soconnect || []), ...(cfgC.soreach || [])].map(c => String(c).toLowerCase().trim()).filter(Boolean);
      const CONCS_DEF = CONCS.length ? CONCS : ['partoo', 'brevo', 'guest suite', 'guestsuite', 'simio', 'malou'];
      const nomAgentI = 'Import — ' + source;
      // Employés de l'entreprise AUTEURE du post (dérivée de l'URL : /posts/malou_… → « Malou ») :
      // exclus même si elle n'est pas dans la liste des concurrents — ses salariés likent leur
      // propre post, ce ne sont jamais des leads (cas Hugues Cohen @ Malou, 05/08).
      const societePost = extraireConcurrent(postUrl || source).toLowerCase().trim();
      const exclusEmployeurs = societePost && societePost.length >= 3 ? [...CONCS_DEF, societePost] : CONCS_DEF;
      // Module Sofy face à l'auteur du post (config concurrents, repli mots-clés) → oriente l'accroche :
      // un post SMS Partner doit amener vers SoReach, pas vers les avis Google (cas relevé le 05/08).
      const MODULES_CONC = { soview: 'Soview (fiches Google, avis clients, visibilité locale)', soconnect: 'SoConnect (messagerie & relation client omnicanale)', soreach: 'SoReach (campagnes SMS/RCS)' };
      const normC = s => String(s || '').toLowerCase().replace(/[\s\-]/g, '');
      const socN = normC(societePost);
      let moduleDuPost = null;
      if (socN) {
        for (const k of ['soview', 'soconnect', 'soreach']) {
          if ((cfgC[k] || []).some(c => { const n = normC(c); return n.length >= 3 && (socN.includes(n) || n.includes(socN)); })) { moduleDuPost = k; break; }
        }
        if (!moduleDuPost) {
          if (/sms|rcs|message/.test(socN)) moduleDuPost = 'soreach';
          else if (/avis|review|local|presence/.test(socN)) moduleDuPost = 'soview';
        }
      }
      const resImp = { ok: true, importes: profilsImp.length, nouveaux: nouveauxI.length, matches: 0, hotleads: 0, exclus_ia: 0, exclus_employeur: 0, societe_du_post: societePost || null,
        detail: { hotleads: [], matches: [], exclus: [], deja_vus: forcerI ? [] : profilsImp.filter(p => dejaVusI.has(p.cle)).map(p => p.nom) } };

      // ── Filtre IA en amont (demande Didier 05/08) : seuls les profils DANS LA CIBLE deviennent
      // des hot leads (décideurs marketing/commercial/direction d'entreprises B2C) — les étudiants,
      // scientifiques, freelances/agences, profils tech/RH sont écartés (perte de temps SDR).
      // Les profils qui MATCHENT une liste en veille ne passent pas par le filtre (déjà nos cibles).
      // ⚠️ Traitement PAR LOTS de 25 : avec 91 profils d'un coup la réponse dépassait max_tokens,
      // le JSON arrivait tronqué et le repli « tout garder » polluait les Hot Leads (07/08).
      let garderIA = new Set();
      let socIA = {};        // indice → société extraite de la tagline par l'IA
      const nonAnalyses = new Set(); // lot dont l'IA a échoué → exclus (repêchables avec ♻️)
      const CONSIGNES = `Tu qualifies des profils LinkedIn ayant réagi à un post sur le marketing local / les avis clients. Nos produits (pilotage de fiches Google & avis, centralisation des conversations clients, campagnes SMS) ciblent les DÉCIDEURS — dirigeant, DG, gérant, directeur ou responsable marketing / communication / digital / commercial / relation client / réseau-franchise-retail — d'entreprises B2C : commerces, retail, franchises, restauration/CHR, automobile, beauté/santé, services locaux, grandes marques.
À EXCLURE : étudiants et alternants (même en marketing), chercheurs/scientifiques, freelances/consultants/agences (growth, SEO, com...), profils RH/tech/finance/juridique, **chefs de projet / project managers / product managers / product owners, formateurs, responsables pédagogiques, coachs, designers, développeurs**, employés d'éditeurs de logiciels (concurrents ou non), et TOUT profil travaillant chez l'entreprise qui a publié le post${societePost ? ` (« ${societePost} »)` : ''}. EXCLURE AUSSI les profils institutionnels et corporate SANS points de vente : fédérations/syndicats professionnels (Medef, Apec, Syntec...), présidents d'associations/fondations, cabinets de conseil/audit/expertise, banque/assurance corporate, collectivités — notre cible a des BOUTIQUES, AGENCES ou CLIENTS GRAND PUBLIC. EXCLURE AUSSI les vendeurs EXÉCUTANTS sans entreprise B2C cible identifiable : Inside Sales, Sales/Account Executive, Account Manager, SDR/BDR, Business Developer, Customer Success — un vendeur qui prospecte n'est PAS un décideur qui achète (seuls les DIRECTEURS/RESPONSABLES commerciaux d'entreprises B2C restent dans la cible). Fonction vide = GARDER ; fonction prestigieuse mais hors commerce B2C = EXCLURE. Tagline en simple liste de mots-clés d'un secteur B2C SANS employeur identifiable, SANS marqueur freelance/agence/consultant et SANS intitulé de vendeur exécutant = AMBIGUË → GARDER, le SDR tranchera. Dans le doute sur un intitulé NON commercial (projet, produit, tech, formation, RH) : EXCLURE.`;
      if (process.env.ANTHROPIC_API_KEY && nouveauxI.length) {
        const TAILLE = 25;
        for (let d = 0; d < nouveauxI.length; d += TAILLE) {
          const lot = nouveauxI.slice(d, d + TAILLE).map((p, k) => ({ i: d + k, nom: p.nom, fonction: (p.occupation || '').slice(0, 120) }));
          const veutAccroche = postTexte && d === 0; // l'accroche ne se demande qu'une fois
          let ok = false;
          try {
            const rIA = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-sonnet-4-6' /* filtre de qualification des likers : la QUALITÉ primes sur le coût (un faux positif pollue les Hot Leads, un faux négatif perd un lead) — arbitrage Didier 07/08 */, max_tokens: 2000,
                messages: [{ role: 'user', content: `${CONSIGNES}
Profils : ${JSON.stringify(lot)}
${veutAccroche ? `Texte du post (publié par « ${societePost || 'inconnu'} »${moduleDuPost ? `, concurrent de notre module ${MODULES_CONC[moduleDuPost]}` : ''}) : «${postTexte.slice(0, 800)}»\n` : ''}Réponds UNIQUEMENT avec un objet JSON, sans texte autour : {"garder":[indices des profils à garder],"societes":{"<indice>":"nom de l'entreprise UNIQUEMENT si la fonction du profil la mentionne (ex : Head of sales @ Décathlon → Décathlon) — omets l'indice sinon, n'invente jamais"}${veutAccroche ? `,"accroche":"1 phrase d'ouverture d'appel pour le SDR, 40 mots MAXIMUM et complète : « J'ai vu que vous avez réagi au post de ${societePost || 'X'} sur [le sujet RÉEL du texte ci-dessus — INTERDICTION d'évoquer un thème absent du post] », puis un pont naturel vers ${moduleDuPost ? 'notre terrain : ' + MODULES_CONC[moduleDuPost] : 'le module Sofy le plus proche du sujet du post (Soview=avis Google/visibilité locale, SoConnect=messagerie client, SoReach=SMS/RCS)'}"` : ''}}` }]
              })
            });
            const dIA = await rIA.json().catch(() => null);
            if (rIA.ok && dIA) {
              const brutIA = ((dIA.content || []).map(c => c.text || '').join('')).replace(/```json|```/g, '');
              const pIA = JSON.parse(brutIA.slice(brutIA.indexOf('{'), brutIA.lastIndexOf('}') + 1));
              if (Array.isArray(pIA.garder)) {
                pIA.garder.map(Number).forEach(n => garderIA.add(n));
                ok = true;
              }
              if (pIA.accroche) resImp.accroche = String(pIA.accroche).slice(0, 450);
              if (pIA.societes && typeof pIA.societes === 'object') Object.assign(socIA, pIA.societes);
            }
          } catch (_) {}
          // Lot non qualifié (IA en erreur / réponse illisible) : on N'ajoute PAS ces profils aux Hot
          // Leads — ils seraient non filtrés. Ils sont signalés et restent repêchables (♻️).
          if (!ok) lot.forEach(x => nonAnalyses.add(x.i));
        }
        resImp.ia_lots = Math.ceil(nouveauxI.length / TAILLE);
        if (nonAnalyses.size) resImp.ia_non_analyses = nonAnalyses.size;
      } else {
        nouveauxI.forEach((_, i) => garderIA.add(i)); // pas de clé IA : comportement d'avant (tout garder)
      }

      for (let iP = 0; iP < nouveauxI.length; iP++) {
        const p = nouveauxI[iP];
        const m = (p.url && index.get(p.url)) || (p.nomNorm && indexNoms.get(p.nomNorm));
        if (!m) {
          if (cfgHL.actif === false || !p.nom) continue;
          // Comparaison sans espaces/tirets : « Sales chez Hey Pongo » doit matcher « heypongo » —
          // et l'URL du profil compte aussi (cas /in/titouan-billy-partoo/ sans Partoo dans la tagline)
          const occN = (p.occupation || '').toLowerCase().replace(/[\s\-]/g, '');
          const urlN = String(p.brut || p.url || '').toLowerCase().replace(/[\s\-]/g, '');
          const empl = exclusEmployeurs.find(c => { const n = String(c).replace(/[\s\-]/g, ''); return n.length >= 3 && (occN.includes(n) || urlN.includes(n)); });
          if (empl) { resImp.exclus_employeur++; resImp.detail.exclus.push({ nom: p.nom, raison: 'employé « ' + empl + ' »' + (occN.includes(String(empl).replace(/[\s\-]/g, '')) ? '' : ' (URL du profil)') }); continue; }
          if (nonAnalyses.has(iP)) { resImp.exclus_ia++; resImp.detail.exclus.push({ nom: p.nom, raison: '⚠️ non analysé (filtre IA indisponible sur ce lot) — relance avec ♻️' }); continue; }
          if (!garderIA.has(iP)) { resImp.exclus_ia++; resImp.detail.exclus.push({ nom: p.nom, raison: 'hors cible (filtre IA)' + (p.occupation ? ' — ' + p.occupation.slice(0, 60) : '') }); continue; }
          const sigT = typerSignal(nomAgentI, p);
          const r2 = await ajouterHotLead({
            nom_complet: p.nom, email: null,
            entreprise: String(socIA[iP] || extraireSociete(p.occupation) || '').slice(0, 80) || null,
            linkedin_brut: p.brut || null, fonction: p.occupation || '',
            source: nomAgentI, type: 'linkedin', post: postUrl, accroche: resImp.accroche || null,
            detail: `${sigT.emoji} ${p.nom} ${sigT.label} — ${source}${resImp.accroche ? '\n🗣 ' + resImp.accroche : ''}`
          }, cfgHL);
          clesVuesI.push(p.cle);
          if (r2.ajoute) {
            resImp.hotleads++;
            resImp.detail.hotleads.push(p.nom);
            const lienFiche = `${(process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '')}/?liste=${r2.liste_id}&fiche=${encodeURIComponent(r2.cle_fiche || '')}`;
            await envoyerSlack(`🔥 *Nouveau Hot Lead* (LinkedIn) — ${p.nom}${p.occupation ? ' · ' + p.occupation.slice(0, 70) : ''}\n${sigT.emoji} ${sigT.label} — ${source}\n📂 <${lienFiche}|Ouvrir la fiche dans Sofy Scrap>`);
          } else {
            resImp.detail.deja_vus.push(p.nom + ' (' + (r2.raison || 'déjà en Hot Leads') + ')');
          }
          continue;
        }
        resImp.matches++;
        resImp.detail.matches.push(p.nom || m.contact || '');
        clesVuesI.push(p.cle);
        const sigT = typerSignal(nomAgentI, p);
        const detail = `${sigT.emoji} ${p.nom || m.contact} ${sigT.label} — ${source}${p.occupation ? ' · ' + p.occupation.slice(0, 80) : ''}`;
        await sql`INSERT INTO signaux (liste_id, entreprise_nom, contact_nom, linkedin, type, source, detail, sdr)
          VALUES (${m.liste.id}, ${m.entreprise}, ${m.contact || p.nom}, ${p.brut}, 'linkedin', ${nomAgentI}, ${detail}, ${m.liste.sdr})`;
        const ents = aSauver.get(m.liste.id) || m.liste.entreprises;
        const e = ents[m.ei];
        e.signal_hot = true;
        const sig = { type: 'linkedin', interaction: sigT.label, emoji: sigT.emoji, source: nomAgentI, detail: detail + (resImp.accroche ? '\n🗣 ' + resImp.accroche : ''), accroche: resImp.accroche || null, post: postUrl || source, linkedin: p.brut || '', date: new Date().toISOString() };
        if (m.ci >= 0 && e.contacts && e.contacts[m.ci]) e.contacts[m.ci].signal = sig;
        else e.signal = sig;
        aSauver.set(m.liste.id, ents);
        await envoyerSlack(`${sigT.emoji} *Signal LinkedIn* — ${m.contact || p.nom} (${m.entreprise})\n${sigT.label} — ${source}\nListe « ${m.liste.nom} » · SDR *${m.liste.sdr}*`);
      }
      for (const [listeId, ents] of aSauver) {
        await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${listeId}`;
      }
      const tousI = [...new Set([...dejaVusI, ...clesVuesI])].slice(-5000);
      await sql`INSERT INTO veille_etat (cle, deja_vus, maj) VALUES ('import', ${JSON.stringify(tousI)}, NOW())
                ON CONFLICT (cle) DO UPDATE SET deja_vus = ${JSON.stringify(tousI)}, maj = NOW()`;
      return res.status(200).json(resImp);
    }

    // ── 2. Chaque Phantom : résultat → diff → match ──
    for (const agentId of agentIds) {
      resume.agents++;
      // Métadonnées de l'agent (nom + dossier S3 du dernier résultat)
      const rAgent = await fetch(`https://api.phantombuster.com/api/v2/agents/fetch?id=${agentId}`, {
        headers: { 'X-Phantombuster-Key-1': pbKey }
      });
      const agent = await rAgent.json().catch(() => ({}));
      const nomAgent = agent.name || `Phantom ${agentId}`;
      // ── Détection d'un Phantom en erreur (cookie LinkedIn mort, désync...) → alerte Slack ──
      const statut = (agent.lastEndStatus || agent.lastEndMessage || '').toString().toLowerCase();
      const enErreur = statut && !['success', 'finished', 'ok'].some(s => statut.includes(s));
      if (enErreur) {
        resume.erreurs = (resume.erreurs || 0) + 1;
        await envoyerSlack(`⚠️ *Veille LinkedIn — Phantom en erreur*\n« ${nomAgent} » : ${agent.lastEndStatus || agent.lastEndMessage || 'statut inconnu'}\n👉 Vérifie le cookie LinkedIn (li_at) dans PhantomBuster — la veille ne remonte aucun signal tant que le Phantom est en erreur.`);
      }
      let data = null;
      if (agent.orgS3Folder && agent.s3Folder) {
        const rRes = await fetch(`https://phantombuster.s3.amazonaws.com/${agent.orgS3Folder}/${agent.s3Folder}/result.json`);
        if (rRes.ok) data = await rRes.json().catch(() => null);
      }
      if (!data) {
        // Repli : sortie du dernier container
        const rOut = await fetch(`https://api.phantombuster.com/api/v2/agents/fetch-output?id=${agentId}`, {
          headers: { 'X-Phantombuster-Key-1': pbKey }
        });
        const out = await rOut.json().catch(() => ({}));
        if (out && out.resultObject) { try { data = JSON.parse(out.resultObject); } catch (_) {} }
      }
      if (!data) {
        // Aucune donnée récupérée : souvent un cookie LinkedIn mort. On alerte (une fois) si pas déjà signalé en erreur.
        if (!enErreur) {
          resume.vides = (resume.vides || 0) + 1;
          await envoyerSlack(`⚠️ *Veille LinkedIn — aucun résultat*\n« ${nomAgent} » n'a renvoyé aucune donnée.\n👉 Le Phantom tourne-t-il ? Cookie LinkedIn (li_at) à vérifier dans PhantomBuster.`);
        }
        continue;
      }

      const profils = extraireProfils(data);

      // Diff avec les profils déjà vus pour cet agent
      const etat = await sql`SELECT deja_vus FROM veille_etat WHERE cle = ${String(agentId)}`;
      const dejaVus = new Set(etat.length ? etat[0].deja_vus : []);
      const premierPassage = etat.length === 0;
      const nouveaux = profils.filter(p => !dejaVus.has(p.cle));
      resume.nouveaux += premierPassage ? 0 : nouveaux.length;

      // Mémoriser l'état (plafonné à 5000 profils)
      const tous = [...new Set([...dejaVus, ...profils.map(p => p.cle)])].slice(-5000);
      await sql`INSERT INTO veille_etat (cle, deja_vus, maj) VALUES (${String(agentId)}, ${JSON.stringify(tous)}, NOW())
                ON CONFLICT (cle) DO UPDATE SET deja_vus = ${JSON.stringify(tous)}, maj = NOW()`;

      if (premierPassage) continue; // 1er passage = référence, pas d'alertes (sinon spam)

      // Croisement avec les contacts en veille
      // Config Hot Leads (une fois par agent)
      const cfgRowsHL = await sql`SELECT valeur FROM config WHERE cle = 'hotleads'`;
      const cfgHL = cfgRowsHL.length ? cfgRowsHL[0].valeur : {};
      // Liste des concurrents : lue depuis la config (onglet Envois & mapping), repli sur une liste par défaut
      const cfgRowsC = await sql`SELECT valeur FROM config WHERE cle = 'concurrents'`;
      const cfgC = cfgRowsC.length ? cfgRowsC[0].valeur : {};
      const CONCURRENTS = [
        ...(cfgC.soview || []), ...(cfgC.soconnect || []), ...(cfgC.soreach || [])
      ].map(c => String(c).toLowerCase().trim()).filter(Boolean);
      const CONCURRENTS_DEF = CONCURRENTS.length ? CONCURRENTS : ['partoo', 'brevo', 'guest suite', 'guestsuite', 'simio', 'malou'];

      for (const p of nouveaux) {
        const m = (p.url && index.get(p.url)) || (p.nomNorm && indexNoms.get(p.nomNorm));
        if (!m) {
          // ── Non matché → Hot Lead auto (sauf employés des concurrents et premier passage) ──
          if (premierPassage || cfgHL.actif === false || !p.nom) continue;
          const occ = (p.occupation || '').toLowerCase();
          if (CONCURRENTS_DEF.some(c => occ.includes(c))) continue; // employé d'un concurrent ≠ lead
          const sigT = typerSignal(nomAgent, p);
          const societe = extraireSociete(p.occupation);
          const r2 = await ajouterHotLead({
            nom_complet: p.nom, email: null, entreprise: societe,
            linkedin_brut: p.brut || null, fonction: p.occupation || '',
            source: nomAgent, type: 'linkedin',
            detail: `${sigT.emoji} ${p.nom} ${sigT.label}${p.post ? ' — ' + p.post : ''}`
          }, cfgHL);
          if (r2.ajoute) {
            resume.hotleads = (resume.hotleads || 0) + 1;
            const concurrent = extraireConcurrent(p.post);
            const lienFiche = `${(process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '')}/?liste=${r2.liste_id}&fiche=${encodeURIComponent(r2.cle_fiche || '')}`;
            await envoyerSlack(`🔥 *Nouveau Hot Lead* (LinkedIn) — ${p.nom}${p.occupation ? ' · ' + p.occupation.slice(0, 70) : ''}\n${sigT.emoji} ${sigT.label}${concurrent ? ' sur un post *' + concurrent + '*' : ' (concurrent surveillé)'}${p.brut ? '\n👤 ' + p.brut : ''}${p.post ? '\n📝 ' + p.post : ''}\n📂 <${lienFiche}|Ouvrir la fiche dans Sofy Scrap> — enrichissement auto au chargement`);
          }
          continue;
        }
        resume.matches++;
        const sigT = typerSignal(nomAgent, p);
        const detail = `${sigT.emoji} ${p.nom || m.contact} ${sigT.label}${p.post ? ' — ' + p.post : ''}${p.occupation ? ' · ' + p.occupation.slice(0, 80) : ''}`;
        await sql`INSERT INTO signaux (liste_id, entreprise_nom, contact_nom, linkedin, type, source, detail, sdr)
          VALUES (${m.liste.id}, ${m.entreprise}, ${m.contact || p.nom}, ${p.brut}, 'linkedin', ${nomAgent}, ${detail}, ${m.liste.sdr})`;
        // Marquer la fiche 🔥
        const ents = aSauver.get(m.liste.id) || m.liste.entreprises;
        const e = ents[m.ei];
        e.signal_hot = true;
        const sig = { type: 'linkedin', interaction: sigT.label, emoji: sigT.emoji, source: nomAgent, detail, post: p.post || '', linkedin: p.brut || '', concurrent: extraireConcurrent(p.post), date: new Date().toISOString() };
        if (m.ci >= 0 && e.contacts && e.contacts[m.ci]) e.contacts[m.ci].signal = sig;
        else e.signal = sig;
        aSauver.set(m.liste.id, ents);
        await envoyerSlack(`${sigT.emoji} *Signal LinkedIn* — ${m.contact || p.nom} (${m.entreprise})\n${sigT.label}${p.occupation ? ' · ' + p.occupation.slice(0,70) : ''}\nListe « ${m.liste.nom} » · SDR *${m.liste.sdr}*${p.brut ? '\n👤 ' + p.brut : ''}${p.post ? '\n📝 ' + p.post : ''}`);
      }
    }

    // ── 3. Sauvegarder les fiches marquées ──
    for (const [listeId, ents] of aSauver) {
      await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${listeId}`;
    }

    return res.status(200).json({ ok: true, ...resume });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur veille', detail: err.message });
  }
}
