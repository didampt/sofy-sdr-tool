// /api/p.js — 🌐 La page que le prospect voit. Servie sur https://www.sofyscrap.com/p/<jeton>
//
// Pourquoi une page et pas un PDF : on sait quand le client l'ouvre, combien de fois et jusqu'où
// il descend — ce que Didier voulait comme signal chaud. Le PDF reste disponible : le bouton
// « ⬇️ PDF » déclenche l'impression du navigateur, avec une feuille de style print dédiée.
//
// GET  /p/<jeton>            → rend la présentation, compte l'ouverture
// POST /api/p?j=…&s=N        → profondeur de lecture (envoyée par la page elle-même)
//
// Publique par jeton non devinable (12 caractères aléatoires), noindex : jamais référencée.

import { sql } from './db.js';
import { imagesDe, visuelsInstit } from './kb-visuels.js';
import crypto from 'crypto';

export const config = { maxDuration: 60 };

const LIEN_DEMO = () => process.env.SOFY_LIEN_DEMO || 'https://go.sofy.fr/meetings/mbouly/demo-site-web';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// **gras** → <strong> (les blocs de la base de connaissance en contiennent)
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// Une IA qui écrit en français écrit « 1,7 ». Number('1,7') vaut NaN : c'est ce qui a vidé la
// planche trajectoire du premier document envoyé. Toute valeur numérique passe désormais par ici.
const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
};
const etoiles = n => {
  const v = Math.max(0, Math.min(5, num(n) || 0));
  return [1, 2, 3, 4, 5].map(k => `<span class="et${v >= k ? ' on' : (v > k - 1 ? ' mi' : '')}">★</span>`).join('');
};

// ── Planche « Pourquoi Sofy » : STATIQUE, injectée au rendu (demande Didier, 26/08) ─────────
// Insérée avant la planche CTA de TOUS les documents, y compris ceux déjà générés : elle vit ici,
// pas dans doc.planches — zéro rédaction IA, zéro coût, une seule version en circulation, et une
// correction de texte se déploie partout d'un push. Les visuels fixes sont dans public/ ; les
// logos clients viennent de la bibliothèque (instit.clients), comme le bandeau de la planche
// finale : un logo ajouté ou retiré en base se répercute seul.
// L'angle (validé sur wireframe v4) : Sofy est moins connu que les grands acteurs métropole —
// la réassurance passe par l'humain (Cloé, coach dédiée), l'histoire (Optima Group / SunSMS,
// 14 ans), les habilitations (Google Partner, Partner RBM, ARCEP, agrégateur direct) et les
// références. Chiffres alignés sur SOFY_REPERES (2012, 5 000+, 20) — ne pas les faire diverger.
const PLANCHE_POURQUOI = {
  role: 'pourquoi',
  eyebrow: 'POURQUOI SOFY',
  titre: 'Une équipe qui connaît votre réseau — et des enseignes qui nous confient le leur',
  texte: "Sofy est une marque d'**Optima Group**, éditeur de SunSMS : 14 ans de messagerie d'entreprise et de visibilité locale, depuis la France métropolitaine, La Réunion, la Guadeloupe et Barcelone. Pas de hotline anonyme : **une coach dédiée** qui connaît vos établissements, vos saisons et vos équipes."
};

// ── Couverture v2 : l'audit se vend avec ses propres mesures (demande Didier, 26/08) ────────
// Trois tuiles CALCULÉES depuis les mesures du document — position locale, avis, aperçu IA —
// chacune renvoyant à sa planche. Rien n'est rédigé : s'il manque une mesure, la tuile saute ;
// à moins de deux tuiles, la couverture reste celle d'origine (pas de bande décorative vide).
// L'accroche est fixe parce qu'elle est vraie pour toutes les analyses : les trois tests sont
// toujours faits. La méthodo (couv_texte rédigé) descend en petite ligne grise.
function couvertureV2(mes, plR, meta) {
  const g = (mes && mes.google) || {};
  const au = g.audit_fiche || {};
  const iv = g.visibilite_ia || null;
  const num = r => { const i = plR.findIndex(x => x && x.role === r); return i >= 0 ? 'planche ' + String(i + 1).padStart(2, '0') : ''; };
  const t = [];
  if (au.position_locale != null && au.requete_testee) {
    const pos = au.position_locale;
    const autres = (au.trois_premiers || [])
      .filter(c => c && c.nom && (c.position || 0) !== pos)
      .slice(0, 2).map(c => c.nom);
    t.push({
      valeur: pos + 'ᵉ',
      label: `sur « ${au.requete_testee} »${pos === 1 && autres.length ? ` — devant ${autres.join(' et ')}` : ''}`,
      ou: num('marche')
    });
  }
  if (typeof g.total_avis === 'number' && g.note_moyenne != null) {
    const rivaux = (au.trois_premiers || []).filter(c => c && c.nom && typeof c.avis === 'number'
      && (c.position || 0) !== au.position_locale && c.avis > g.total_avis);
    const rival = rivaux.sort((a, b) => b.avis - a.avis)[0] || null;
    t.push({
      valeur: g.total_avis + ' avis',
      label: `pour porter votre ${String(g.note_moyenne).replace('.', ',')}/5${rival ? ` — ${rival.nom} en affiche ${rival.avis}` : ''}`,
      ou: num('constat')
    });
  }
  if (iv && iv.apercu_ia_affiche) {
    t.push(iv.prospect_cite
      ? { valeur: iv.rang_de_citation ? `n°${iv.rang_de_citation}` : 'cité',
          label: "votre place dans la réponse de l'IA de Google", ou: num('geo_ia') || num('marche') }
      : { valeur: '0',
          label: "mention de votre enseigne dans la réponse de l'IA de Google", ou: num('geo_ia') || num('marche') });
  }
  if (t.length < 2) return null;
  const meta2 = [`${plR.length} planches · ~5 minutes de lecture`];
  if (meta && meta.cree_le) {
    try { meta2.push('relevés du ' + new Date(meta.cree_le).toLocaleDateString('fr-FR')); } catch (_) {}
  }
  if (meta && meta.expire_le) {
    const j = Math.ceil((new Date(meta.expire_le).getTime() - Date.now()) / 86400000);
    if (j > 0) meta2.push(`lien privé, valable ${j} jour${j > 1 ? 's' : ''}`);
  }
  return {
    accroche: "Vos clients vous cherchent de trois façons : Google, les avis, et maintenant l'IA. Nous avons testé les trois **sur votre enseigne** — voici ce qu'ils trouvent.",
    teasers: t.slice(0, 3),
    meta: meta2
  };
}

// Bandeau institutionnel de la dernière planche. Ces éléments ne dépendent PAS du prospect :
// les faire rédiger à chaque analyse coûterait des jetons pour un résultat identique, et
// exposerait une mention réglementée (ARCEP) à une reformulation approximative. Ils sont donc
// écrits ici une fois pour toutes ; seul le texte du rendez-vous reste personnalisé.
// Pour modifier une mention : cette constante est le seul endroit à toucher.
const SOFY_REPERES = [
  { c: '2012', t: 'année de création' },
  { c: '5 000+', t: 'entreprises accompagnées' },
  { c: 'ARCEP', t: 'agrégateur agréé' },
  { c: '20', t: 'collaborateurs' }
];

// Le passage du problème à la réponse, entre les deux cartes du duel : Budy, l'IA Sofy. Ce
// n'était qu'une pastille « Sofy » — Didier veut l'agent, pas la marque, parce que c'est Budy qui
// exécute (il rédige les réponses aux avis, il répond dans la messagerie). Un point d'énergie
// traverse le lien de gauche à droite : le problème entre, la réponse sort.
const BUDY = `<div class="bd reveal" style="--d:120ms">
  <svg class="bd-r" viewBox="0 0 64 64" role="img" aria-label="Budy, l'IA de Sofy">
    <circle cx="32" cy="32" r="30" class="bd-halo"/>
    <circle cx="32" cy="32" r="24" fill="#14103A"/>
    <path d="M32 12v4" stroke="#F0428A" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="32" cy="10.5" r="2.6" fill="#F0428A" class="bd-ant"/>
    <rect x="20" y="22" width="24" height="19" rx="7.5" fill="#fff"/>
    <g class="bd-y"><circle cx="27" cy="30.5" r="2.6" fill="#14103A"/><circle cx="37" cy="30.5" r="2.6" fill="#14103A"/></g>
    <path d="M27.5 35.6q4.5 3.2 9 0" stroke="#14103A" stroke-width="1.9" stroke-linecap="round" fill="none"/>
  </svg>
  <span class="bd-n">Budy · IA Sofy</span>
</div>`;

function planche(p, i, total, mes, logo, sdr, images, photoSite, instit) {
  const sombre = i % 2 === 1;
  const chiffres = (p.chiffres || []).map(c => `
    <div class="kpi">
      <div class="kpi-v${String(c.valeur).length > 18 ? ' long' : (String(c.valeur).length > 9 ? ' moyen' : '')}" data-n="${esc(String(c.valeur).replace(',', '.'))}">${esc(c.valeur)}${c.unite ? `<span class="kpi-u">${esc(c.unite)}</span>` : ''}</div>
      <div class="kpi-l">${md(c.legende)}</div>
      ${c.source ? `<div class="kpi-s">${esc(c.source)}</div>` : ''}
    </div>`).join('');
  const points = (p.points || []).map((x, k) => `
    <div class="pt">
      <span class="pt-n">${k + 1}</span>
      <div><div class="pt-t">${md(x.titre)}</div><div class="pt-x">${md(x.texte)}</div>
      ${x.repond_a ? `<div class="pt-r">↳ répond à : ${md(x.repond_a)}</div>` : ''}
      ${x.source ? `<div class="pt-s">${esc(x.source)}</div>` : ''}</div>
    </div>`).join('');
  // Diagnostic : une carte par problème mesuré, avec son impact quand il est calculable
  const problemes = (p.problemes || []).map((x, k) => `
    <div class="pb reveal" style="--d:${k * 90}ms">
      <div class="pb-t">${md(x.titre)}</div>
      <div class="pb-x">${md(x.texte)}</div>
      ${x.impact ? `<div class="pb-i">${md(x.impact)}</div>` : ''}
    </div>`).join('');
  // Projection : LE graphique. Barre actuelle → barre cible, animée à l'entrée dans l'écran.
  const proj = (p.projection || []).map((x, k) => {
    const max = num(x.max) || Math.max(num(x.cible) || 0, num(x.actuel) || 0) * 1.15 || 1;
    const pa = Math.max(2, Math.min(100, Math.round((num(x.actuel) || 0) / max * 100)));
    const pc = Math.max(2, Math.min(100, Math.round((num(x.cible) || 0) / max * 100)));
    const fmt = v => String(v).replace('.', ',');
    return `<div class="pj reveal" style="--d:${k * 110}ms">
      <div class="pj-h"><span class="pj-n">${md(x.indicateur)}</span>${x.delai ? `<span class="pj-d">objectif ${esc(x.delai)}</span>` : ''}</div>
      <div class="pj-row"><span class="pj-lab">aujourd'hui</span>
        <div class="pj-bar"><i class="now" style="--w:${pa}%"></i></div>
        <span class="pj-v">${fmt(x.actuel)}${esc(x.unite || '')}</span></div>
      <div class="pj-row"><span class="pj-lab">visé</span>
        <div class="pj-bar"><i class="goal" style="--w:${pc}%"></i></div>
        <span class="pj-v goal-v">${fmt(x.cible)}${esc(x.unite || '')}</span></div>
      ${x.appui ? `<div class="pj-s">${md(x.appui)}</div>` : ''}
    </div>`;
  }).join('');
  // Planche « duel » : la pièce qui vend. À gauche le problème mesuré et ce qu'il coûte, à
  // droite le mécanisme Sofy en trois étapes et le résultat visé. Format repris du deck Partoo,
  // qui met systématiquement une solution en face d'un problème plutôt qu'un catalogue.
  const vis = p.visuel_id && images && images[p.visuel_id] ? images[p.visuel_id] : null;
  const sc0 = (mes && mes.scoring) || null;
  const duel = (p.probleme && p.solution) ? `
    ${vis ? `<figure class="ill reveal"><img src="${esc(vis.image)}" alt="${esc(vis.description || '')}" loading="lazy"></figure>` : ''}
    <div class="duel">
      <div class="dl-p reveal">
        <div class="dl-lab">Ce que nous avons mesuré</div>
        <div class="dl-c">${md(p.probleme.constat)}</div>
        ${/* « Ce que ça coûte » adressé à un client se lit comme un reproche sur ce qu'il a acheté.
              Sur un document d'expansion, le même champ dit ce qui reste à gagner. */''}
        ${p.probleme.cout ? `<div class="dl-cout"><span>${(mes && mes.mode === 'expansion') ? 'Ce qui reste à gagner' : 'Ce que ça coûte'}</span>${md(p.probleme.cout)}</div>` : ''}
      </div>
      ${BUDY}
      <div class="dl-s reveal" style="--d:180ms">
        <div class="dl-lab dl-lab-s">La réponse Sofy</div>
        <div class="dl-n">${md(p.solution.nom)}</div>
        ${(p.solution.comment || []).length ? `<ol class="dl-m">${(p.solution.comment || []).map(x => `<li>${md(x)}</li>`).join('')}</ol>` : ''}
        ${p.solution.resultat ? `<div class="dl-r"><span>Résultat visé</span>${md(p.solution.resultat)}</div>` : ''}
      </div>
    </div>
    ${p.chiffre_cle && p.chiffre_cle.valeur ? `<div class="dl-k reveal" style="--d:260ms">
      <div class="dl-kv" data-n="${esc(String(p.chiffre_cle.valeur).replace(',', '.'))}">${esc(p.chiffre_cle.valeur)}${p.chiffre_cle.unite ? `<span class="kpi-u">${esc(p.chiffre_cle.unite)}</span>` : ''}</div>
      <div class="dl-kl">${md(p.chiffre_cle.legende)}${p.chiffre_cle.source ? `<span>${esc(p.chiffre_cle.source)}</span>` : ''}</div>
    </div>` : ''}` : '';

  // Trajectoire : deux courbes plutôt qu'une. La note ne monte pas seule — c'est le volume d'avis
  // qui la porte. Les deux ensemble se lisent comme une cause et son effet, chacune sur sa propre
  // échelle (axe gauche pour la première, axe droit pour la seconde).
  let courbe = '';
  const serieOk = c => c && Array.isArray(c.points)
    && c.points.filter(x => x && num(x.valeur) != null).length > 1;
  if (serieOk(p.courbe)) {
    const W = 980, H = 380, PX = 66, PY = 52;
    const fmt = v => String(v).replace('.', ',');
    // Géométrie d'une série : son échelle est la sienne, la grille et l'axe des temps sont communs.
    const geo = (c) => {
      const pts = c.points.filter(x => x && num(x.valeur) != null);
      const vals = pts.map(x => num(x.valeur));
      const haut = num(c.max) || Math.max(...vals) * 1.18;
      const bas = Math.min(...vals) * 0.82;
      return {
        pts, unite: c.unite || '', indicateur: c.indicateur || '',
        xy: pts.map((x, k) => [
          PX + k * ((W - PX * 2) / (pts.length - 1)),
          H - PY - ((num(x.valeur) - bas) / (haut - bas || 1)) * (H - PY * 2)
        ])
      };
    };
    const s1 = geo(p.courbe);
    const s2 = serieOk(p.courbe2) ? geo(p.courbe2) : null;
    const trace = s => s.xy.map((c, k) => (k ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
    // Placement des deux valeurs d'un même instant. Elles sont sur la même verticale : sans
    // arbitrage elles s'écrivent l'une sur l'autre (bug vu le 20/08 sur « 4,6★ / 140 avis »).
    // Règle : la première courbe écrit au-dessus, la seconde en dessous ; quand les deux points
    // se touchent, celle du HAUT prend le dessus et celle du BAS passe dessous.
    const lab = (k) => {
      const y1 = s1.xy[Math.min(k, s1.xy.length - 1)][1];
      if (!s2 || !s2.xy[k]) return { l1: y1 - 20, l2: 0 };
      const y2 = s2.xy[k][1];
      let l1 = y1 - 20, l2 = y2 + 27;
      if (l2 > H - PY + 4) l2 = y2 - 20;                 // il écrirait sur la ligne des dates
      if (Math.abs(l1 - l2) < 26) {                      // les deux libellés se marchent dessus
        if (y2 <= y1) { l2 = y2 - 22; l1 = y1 + 31; }     // la seconde est au-dessus : elle monte
        else { l1 = y1 - 22; l2 = y2 + 31; }              // sinon c'est la première qui monte
      }
      return { l1, l2 };
    };
    const d1 = trace(s1);
    const aire = d1 + ` L${s1.xy[s1.xy.length - 1][0].toFixed(1)} ${H - PY} L${s1.xy[0][0].toFixed(1)} ${H - PY} Z`;
    // La série la plus longue porte les libellés de temps.
    const axe = s2 && s2.pts.length > s1.pts.length ? s2 : s1;
    courbe = `<div class="crb reveal">
      <div class="crb-h">
        <span class="crb-i"><i class="crb-d1"></i>${md(s1.indicateur)}</span>
        ${s2 ? `<span class="crb-i"><i class="crb-d2"></i>${md(s2.indicateur)}</span>` : ''}
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="crb-s" role="img" aria-label="Trajectoire visée">
        <defs>
          <linearGradient id="gl" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#5B4FE9"/><stop offset="1" stop-color="#F0428A"/>
          </linearGradient>
          <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#5B4FE9" stop-opacity=".26"/><stop offset="1" stop-color="#F0428A" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${[0, 1, 2, 3].map(k => `<line x1="${PX}" y1="${PY + k * ((H - PY * 2) / 3)}" x2="${W - PX}" y2="${PY + k * ((H - PY * 2) / 3)}" class="crb-g"/>`).join('')}
        <path d="${aire}" fill="url(#ga)" class="crb-a"/>
        ${s2 ? `<path d="${trace(s2)}" fill="none" stroke="#12A594" stroke-width="3.2"
          stroke-linecap="round" stroke-dasharray="9 7" class="crb-l2"/>` : ''}
        <path d="${d1}" fill="none" stroke="url(#gl)" stroke-width="4.5" stroke-linecap="round" class="crb-l"/>
        ${s1.xy.map((c, k) => `<g class="crb-pt" style="--d:${700 + k * 190}ms">
          <circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${k === s1.xy.length - 1 ? 9 : 6}"
            fill="${k === s1.xy.length - 1 ? '#F0428A' : '#5B4FE9'}" stroke="#fff" stroke-width="2.5"/>
          <text x="${c[0].toFixed(1)}" y="${lab(k).l1.toFixed(1)}" class="crb-v">${fmt(s1.pts[k].valeur)}${esc(s1.unite)}</text>
        </g>`).join('')}
        ${s2 ? s2.xy.map((c, k) => `<g class="crb-pt" style="--d:${820 + k * 190}ms">
          <circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${k === s2.xy.length - 1 ? 7.5 : 5}"
            fill="#12A594" stroke="#fff" stroke-width="2.5"/>
          <text x="${c[0].toFixed(1)}" y="${lab(k).l2.toFixed(1)}" class="crb-v2">${fmt(s2.pts[k].valeur)}${esc(s2.unite)}</text>
        </g>`).join('') : ''}
        ${axe.xy.map((c, k) => `<text x="${c[0].toFixed(1)}" y="${H - PY + 24}" class="crb-x">${esc(axe.pts[k].quand || '')}</text>`).join('')}
      </svg>
      ${p.courbe.appui ? `<div class="crb-s2">${md(p.courbe.appui)}</div>` : ''}
      ${p.courbe.hypothese ? `<div class="crb-hy">${md(p.courbe.hypothese)}</div>` : ''}
    </div>`;
  }
  const jalons = (p.jalons || []).map((x, k) => `
    <div class="jl reveal" style="--d:${k * 110}ms">
      <div class="jl-q">${md(x.quand)}</div><div class="jl-t">${md(x.texte)}</div>
    </div>`).join('');
  // ══ Blocs visuels ══ Ce qui fait qu'on reconnaît SA marque et SA fiche, pas un modèle.
  const g = (mes && mes.google) || {};

  // Sa fiche Google, redessinée avec ses vraies valeurs. Un directeur marketing reconnaît
  // immédiatement l'objet : c'est ce qu'un client voit avant d'acheter chez lui.
  const ficheG = (p.fiche_google && (g.note_moyenne != null || (g.fiches || []).length)) ? (() => {
    const pr = (g.fiches || [])[0] || {};
    const nom = mes.nom || pr.nom || '';
    const note = g.note_moyenne != null ? g.note_moyenne : pr.note;
    return `<div class="gmb reveal">
      <div class="gmb-w">
        <div class="gmb-bar"><span class="gmb-d"></span><span class="gmb-d"></span><span class="gmb-d"></span>
          <span class="gmb-u">google.com/maps</span></div>
        <div class="gmb-b">
          <div class="gmb-n">${esc(nom)}</div>
          <div class="gmb-r">
            <span class="gmb-note">${esc(String(note).replace('.', ','))}</span>
            <span class="ets">${etoiles(note)}</span>
            <span class="gmb-a">${g.total_avis != null ? esc(String(g.total_avis).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + ' avis' : ''}</span>
          </div>
          <div class="gmb-l">
            ${pr.adresse ? `<div class="gmb-i"><span>📍</span>${esc(pr.adresse)}</div>` : ''}
            <div class="gmb-i${g.telephone ? '' : ' vide'}"><span>📞</span>${g.telephone ? esc(g.telephone) : 'Aucun numéro renseigné'}</div>
            <div class="gmb-i${g.site_declare ? '' : ' vide'}"><span>🌐</span>${g.site_declare ? esc(g.site_declare) : 'Aucun site web déclaré'}</div>
            ${g.nb_fiches > 1 ? `<div class="gmb-i"><span>🏪</span>${g.nb_fiches} fiches rattachées à votre marque</div>` : ''}
          </div>
        </div>
      </div>
      <div class="gmb-c">Votre fiche, telle qu'un client la voit — relevée le jour de cette analyse.</div>
    </div>`;
  })() : '';

  // Le vrai avis négatif, mis en page comme sur Google. C'est la pièce qui ne s'oublie pas.
  const av = g.avis_negatif || {};
  const avisReel = (p.avis_reel && av.texte) ? `<div class="av reveal">
      <div class="av-h">
        <span class="av-av">${esc(String(mes.nom || '?').trim().charAt(0).toUpperCase())}</span>
        <div><div class="av-n">Un de vos clients</div>
          <div class="av-m"><span class="ets sm">${etoiles(av.note != null ? av.note : 1)}</span>
            ${av.date ? `<span>${esc(av.date)}</span>` : ''}</div></div>
        <span class="av-g">Avis Google</span>
      </div>
      <div class="av-t">${md(av.texte)}</div>
      ${(g.fiches || [])[0] || g.pire_fiche ? `<div class="av-f">sur la fiche ${esc(((g.pire_fiche || {}).nom) || (g.fiches || [])[0].nom)}</div>` : ''}
    </div>` : '';

  // Cascade des fiches : jusqu'à quatre, la plus faible devant (c'est elle qui porte le sujet).
  const fichesCascade = (() => {
    const fs = (g.fiches || []).filter(f => f && f.nom);
    if (!fs.length) return '';
    const tri = fs.slice().sort((a, b) => (a.note || 9) - (b.note || 9)).slice(0, 4);
    const reste = fs.length - tri.length;
    return `<div class="casc reveal">
      ${tri.map((f, k) => `<div class="casc-f" style="--i:${k};--d:${k * 110}ms">
        <div class="casc-bar"><span></span><span></span><span></span><i>google.com/maps</i></div>
        <div class="casc-b">
          <div class="casc-n">${esc(f.nom)}</div>
          <div class="casc-r">
            ${f.note != null ? `<b>${esc(String(f.note).replace('.', ','))}</b><span class="ets sm">${etoiles(f.note)}</span>` : ''}
            ${f.nb_avis != null ? `<span class="casc-a">${esc(String(f.nb_avis))} avis</span>` : ''}
          </div>
          ${f.adresse ? `<div class="casc-i">📍 ${esc(String(f.adresse).slice(0, 52))}</div>` : ''}
          ${k === 0 ? `${g.telephone ? '' : '<div class="casc-i casc-x">📞 aucun numéro</div>'}
            ${g.site_declare ? '' : '<div class="casc-i casc-x">🌐 aucun site web déclaré</div>'}` : ''}
        </div>
      </div>`).join('')}
      ${reste > 0 ? `<div class="casc-p">+ ${reste} autre${reste > 1 ? 's' : ''} fiche${reste > 1 ? 's' : ''}</div>` : ''}
      ${(sc0 && sc0.etablissements && fs.length < sc0.etablissements)
        ? `<div class="casc-m">${sc0.etablissements - fs.length} établissement(s) déclaré(s) sans fiche rattachée</div>` : ''}
    </div>`;
  })();

  // Les défauts relevés sur la fiche : liste sèche, chaque ligne est un fait opposable.
  const defauts = (p.defauts || []).length ? `<div class="dfs">
      ${(p.defauts || []).map((x, k) => `<div class="df reveal" style="--d:${k * 95}ms">
        <span class="df-x">✕</span><span>${md(x)}</span></div>`).join('')}
    </div>` : '';

  // La maquette RCS : le message que le prospect pourrait envoyer demain, écrit pour son métier.
  // ══ La maquette RCS ══
  // Reproduction fidèle d'un écran de messagerie iOS en mode sombre, à partir d'une vraie capture
  // fournie par Didier : cadre de téléphone, barre d'état, en-tête d'expéditeur vérifié avec le
  // logo Sofy, bannière de la carte enrichie, titre, corps tronqué comme le fait iOS, puis le
  // bouton d'action et la barre de saisie. Le prospect ne regarde pas une illustration : il voit
  // ce que ses clients auront réellement sous les yeux.
  const r = p.maquette_rcs || {};
  // Ordre voulu : un visuel choisi pour cette planche, sinon une photo trouvée sur le site du
  // prospect (son propre univers, dans la maquette de son propre message), sinon le dégradé seul.
  const banniere = vis ? vis.image : (photoSite || null);
  const expediteur = r.expediteur || mes.nom || 'Sofy';
  const rcs = (r.titre || r.texte) ? `<div class="rcs reveal">
      <div class="tel">
        <div class="tel-cadre">
          <span class="tel-enc"><i class="tel-hp"></i><i class="tel-cam"></i></span>
          <div class="tel-ec">
            <div class="tel-st"><span>15:40</span><span class="tel-ic">▮▮ ᯤ <b>47</b></span></div>
            <div class="tel-hd">
              <span class="tel-back">‹ <b>313</b></span>
              <span class="tel-exp">
                ${logo ? `<span class="tel-av"><img src="${esc(logo)}" alt=""></span>`
                       : `<span class="tel-av tel-av-i">${esc(String(expediteur).trim().charAt(0).toUpperCase())}</span>`}
                <span class="tel-nom">${esc(expediteur)} ›</span>
              </span>
              <span class="tel-vide"></span>
            </div>
            <div class="tel-date">aujourd'hui à 07:00</div>
            <div class="carte">
              <div class="carte-b"${banniere ? ` style="background-image:url('${esc(banniere)}')"` : ''}>
                <div class="carte-voile"></div>
                ${logo ? `<span class="carte-marque"><img src="${esc(logo)}" alt=""></span>`
                       : `<span class="carte-marque carte-marque-t">${esc(expediteur)}</span>`}
                ${r.titre ? `<div class="carte-h">${md(r.titre)}</div>` : ''}
              </div>
              <div class="carte-c">
                <div class="carte-t">${md(r.titre || '')}</div>
                ${r.texte ? `<div class="carte-x">${md(r.texte)}</div>` : ''}
                <span class="carte-fl">›</span>
              </div>
              ${r.bouton ? `<div class="carte-btn">${esc(r.bouton)}</div>` : ''}
            </div>
            <div class="tel-saisie"><span class="tel-plus">+</span>
              <span class="tel-champ"><i>Objet</i><b>Message texte · SMS</b></span></div>
          </div>
        </div>
      </div>
      <div class="rcs-l">
        <div class="rcs-t">Ce que vos clients recevraient</div>
        <div class="rcs-x">Le RCS affiche le <strong>nom vérifié</strong> de votre enseigne, son logo, une image et un <strong>bouton cliquable</strong> — là où un SMS classique n'affiche qu'un numéro court anonyme. Bascule automatique en SMS si le téléphone ne prend pas le RCS : aucun message perdu.</div>
        ${banniere ? '' : `<div class="rcs-n">L'image de la carte se personnalise avec un visuel de votre univers : ajoutez-en un dans la bibliothèque et il apparaîtra ici.</div>`}
      </div>
    </div>` : '';

  // La planche « position locale » : le podium réel, et ce que dit l'IA de Google.
  const mk = p.marche;
  const marche = mk ? `
    <div class="mk">
      <div class="mk-q reveal">Requête testée : <b>« ${esc(mk.requete || '')} »</b></div>
      <div class="mk-duo">
        <div class="mk-pod reveal">
          <div class="mk-lab">Le podium local</div>
          ${(mk.concurrents || []).map((c, k) => `<div class="mk-l">
            <span class="mk-r r${k + 1}">${k + 1}</span>
            <span class="mk-n">${md(c.nom || '')}</span>
            ${c.note != null ? `<span class="mk-no">${esc(String(c.note).replace('.', ','))}<i>★</i></span>` : ''}
            ${c.avis != null ? `<span class="mk-av">${esc(String(c.avis))} avis</span>` : ''}
          </div>`).join('')}
          ${mk.position
            ? (mk.position > 3 ? `<div class="mk-l mk-moi"><span class="mk-r moi">${mk.position}</span>
                 <span class="mk-n">${esc(mes.nom || 'Vous')}</span><span class="mk-vous">votre place</span></div>` : '')
            : `<div class="mk-abs">${esc(mes.nom || 'Vous')} — <b>absent des résultats locaux</b></div>`}
        </div>
        <div class="mk-ia reveal" style="--d:140ms">
          <div class="mk-lab">Ce que répond l'IA de Google</div>
          ${!mk.ia || !mk.ia.apercu_ia_affiche
            ? `<div class="mk-ix">Google n'affiche pas encore d'aperçu IA sur cette requête. C'est une fenêtre : les enseignes qui structurent leurs données maintenant seront celles qu'il citera demain.</div>`
            : (mk.ia.prospect_cite
                ? `<div class="mk-ok">Vous êtes cité, en source n°${esc(String(mk.ia.rang_de_citation || 1))}.</div>
                   <div class="mk-ix">C'est un acquis à défendre : la citation suit la fraîcheur des données et des avis.</div>`
                : `<div class="mk-non">L'IA ne vous cite pas.</div>
                   ${(mk.ia.entreprises_citees_par_lia || []).length
                      ? `<div class="mk-cites">${mk.ia.entreprises_citees_par_lia.slice(0, 5).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
                   <div class="mk-ix">Vos futurs clients posent déjà la question à une IA. La réponse ne vous mentionne pas.</div>`)}
        </div>
      </div>
      ${(mk.ads && mk.ads.length) ? `<div class="mk-ads reveal" style="--d:200ms">
        <div class="mk-lab">Ceux qui achètent la première place</div>
        <div class="mk-ax">Sur cette requête, ${mk.ads.length === 1 ? 'un concurrent paie' : `${mk.ads.length} concurrents paient`} Google pour passer devant les résultats naturels — dont le vôtre.</div>
        <div class="mk-al">${mk.ads.map(a => `<span class="mk-ai">${md(a.nom || '')}${a.note != null ? ` <b>${esc(String(a.note).replace('.', ','))}★</b>` : ''}${a.google_garanti ? '<i>garanti par Google</i>' : ''}</span>`).join('')}</div>
      </div>` : ''}
      ${mk.apple ? `<div class="mk-ap reveal" style="--d:250ms">
        <div class="mk-lab">Et sur Apple Plans</div>
        ${mk.apple.present
          ? `<div class="mk-ax"><b>Présent</b> en ${esc(String(mk.apple.position || '?'))}ᵉ position${mk.apple.note != null ? `, ${esc(String(mk.apple.note).replace('.', ','))}★` : ', sans note affichée'}${mk.apple.avis != null ? ` (${esc(String(mk.apple.avis))} avis)` : ''}. Un acquis à tenir : Apple ne recopie pas Google, sa fiche se met à jour séparément.</div>`
          : `<div class="mk-ax"><b>Absent</b> des ${esc(String(mk.apple.total_resultats || 0))} résultats rendus par Apple Plans sur cette requête. Un iPhone sur deux téléphones en France : ce client-là ne vous trouve pas, et corriger Google n'y changera rien.</div>`}
      </div>` : ''}
    </div>` : '';

  // Le bilan chiffré : trois jauges, chacune reliée à son module, avec le détail des critères.
  // Les scores viennent du serveur — l'IA ne les touche pas.
  const sc = p.scoring;
  const bilan = (sc && (sc.axes || []).length) ? `
    <div class="bl-h reveal">
      ${sc.etablissements ? `<div class="bl-k"><b>${esc(String(sc.etablissements))}</b><span>établissement${sc.etablissements > 1 ? 's' : ''} déclaré${sc.etablissements > 1 ? 's' : ''}</span></div>` : ''}
      ${sc.fiches_trouvees ? `<div class="bl-k"><b>${esc(String(sc.fiches_trouvees))}</b><span>fiche${sc.fiches_trouvees > 1 ? 's' : ''} Google trouvée${sc.fiches_trouvees > 1 ? 's' : ''}</span></div>` : ''}
      ${sc.note_moyenne != null ? `<div class="bl-k"><b>${esc(String(sc.note_moyenne).replace('.', ','))}<i>★</i></b><span>note moyenne du réseau</span></div>` : ''}
      ${sc.total_avis != null ? `<div class="bl-k"><b>${esc(String(sc.total_avis).replace(/\B(?=(\d{3})+(?!\d))/g, ' '))}</b><span>avis publics cumulés</span></div>` : ''}
    </div>
    <div class="axes">
      ${(sc.axes || []).map((a, k) => {
        const n = a.score == null ? 0 : a.score;
        const cls = a.score == null ? 'nc' : (n >= 70 ? 'ok' : (n >= 45 ? 'moy' : 'bas'));
        const C = 2 * Math.PI * 52;
        return `<div class="ax reveal" style="--d:${k * 120}ms">
          <div class="ax-j">
            <svg viewBox="0 0 120 120" class="ax-s" role="img" aria-label="${esc(a.nom)} : ${a.score == null ? 'non évalué' : n + ' sur 100'}">
              <circle cx="60" cy="60" r="52" class="ax-f"/>
              <circle cx="60" cy="60" r="52" class="ax-v ${cls}"
                style="--c:${C.toFixed(1)};--o:${(C * (1 - n / 100)).toFixed(1)}"/>
            </svg>
            <div class="ax-n">${a.score == null ? '—' : `<b data-n="${n}">${n}</b><i>/100</i>`}</div>
          </div>
          <div class="ax-t">${md(a.nom)}</div>
          <div class="ax-m">${esc(a.module)} · <span class="ax-vd ${cls}">${esc(a.verdict)}</span></div>
          ${a.pourquoi_non_note ? `<div class="ax-pq">${md(a.pourquoi_non_note)}</div>` : ''}
          ${/* Les critères NON VÉRIFIABLES sont sortis de la liste notée et regroupés en bas, sous
                leur propre intitulé. Mélangés aux autres, ils se lisaient comme des manques : sur
                la fiche SOFY France, « agent RCS de marque » apparaissait comme une puce de la
                carte « Communication mobile · CRITIQUE » alors que Sofy EST l'agrégateur qui le
                déclare (retour Didier, 21/08). Une puce dans une carte notée est un reproche, quelle
                que soit sa couleur. */''}
          <div class="ax-c">
            ${(a.criteres || []).filter(x => x.etat !== 'inconnu').map(x => `<div class="ax-l ${esc(x.etat)}">
              <span class="ax-p"></span>
              <span><b>${md(x.libelle)}</b>${x.detail ? ` — ${md(x.detail)}` : ''}</span>
            </div>`).join('')}
          </div>
          ${(() => {
            const nv = (a.criteres || []).filter(x => x.etat === 'inconnu');
            if (!nv.length) return '';
            return `<div class="ax-nv">
              <div class="ax-nv-t">Non vérifiable depuis l'extérieur — à regarder ensemble</div>
              ${nv.map(x => `<div class="ax-l inconnu"><span class="ax-p"></span>
                <span><b>${md(x.libelle)}</b>${x.detail ? ` — ${md(x.detail)}` : ''}</span></div>`).join('')}
            </div>`;
          })()}
        </div>`;
      }).join('')}
    </div>
    ${sc.site_analyse === false ? `<div class="ax-w reveal">Le site n'a pas encore été analysé : les axes Relation client et Communication mobile sont donc partiels. L'audit complet se fait au premier rendez-vous.</div>` : ''}` : '';

  const cit = p.citation && p.citation.texte ? `
    <blockquote class="cit">${md(p.citation.texte)}
      ${p.citation.meta ? `<cite>${esc(p.citation.meta)}</cite>` : ''}</blockquote>` : '';
  // Le témoignage complet, quand la base porte son adresse publique. Un verbatim que le prospect
  // peut aller vérifier lui-même vaut plus que le même verbatim recopié dans une plaquette.
  const lienCas = (p.lien && /^https?:\/\//i.test(String(p.lien.url || ''))) ? `
    <a class="itw reveal" style="--d:120ms" href="${esc(p.lien.url)}" target="_blank" rel="noopener noreferrer">
      <span class="itw-i" aria-hidden="true">▶</span>${esc(p.lien.libelle || 'Lire l\'interview')}
      <span class="itw-x">témoignage client publié</span>
    </a>` : '';
  const couv = p.role === 'couverture';
  // « Pourquoi Sofy » : toujours sur fond nuit (le design de la planche est pensé sombre), le
  // reste de l'alternance clair/sombre ne bouge pas.
  const pq = p.role === 'pourquoi';
  const pourquoiHtml = pq ? `
      <aside class="pq-coach reveal">
        <div class="pq-ch">
          <img src="/pourquoi-cloe.jpg" alt="Cloé, coach Sofy" loading="lazy">
          <div><span>Votre coach dédiée, incluse</span><b>Cloé — coach Sofy</b></div>
        </div>
        <div class="pq-li"><img src="/hab-whatsapp.png" alt="WhatsApp" loading="lazy"><div><b>Joignable là où vous êtes</b><span>par RCS ou sur un WhatsApp dédié à votre réseau — pas de ticket, pas de file d'attente.</span></div></div>
        <div class="pq-li"><span class="pq-pt"></span><div><b>Un relevé chaque mois</b><span>note, avis, position locale : ce qui a bougé, ce qu'on fait le mois suivant.</span></div></div>
        <div class="pq-li"><span class="pq-pt"></span><div><b>Des visios de coaching régulières</b><span>vos fiches en écran partagé — pas un webinaire enregistré.</span></div></div>
      </aside>
      <div class="pq-corps">
        <div class="pq-bande reveal">
          <figure><img src="/pourquoi-sunsms.jpg" alt="Le stand SunSMS au salon e-marketing" loading="lazy"><figcaption>SunSMS (Optima Group) au salon e-marketing — la messagerie d'entreprise depuis 2012</figcaption></figure>
          <figure><img src="/pourquoi-coach.jpg" alt="Une coach Sofy en échange client" loading="lazy"></figure>
        </div>
        <div class="pq-app reveal${(instit && (instit.apps || []).length) ? ' avec-visuel' : ''}">
          <div class="pq-app-c">
            <div class="pq-app-h">
              <img src="${esc((instit && instit.symbole) || '/logo-symbole.png')}" alt="Application Sofy" loading="lazy">
              <div><b>L'application mobile Sofy — toute la puissance Sofy dans votre poche</b>
              <span>iOS &amp; Android, incluse</span>
              <em class="pq-note">4,9 <i>★★★★★</i></em></div>
            </div>
            <ul class="pq-app-l">
              <li>Répondez à vos clients, où que vous soyez</li>
              <li>Transférez une conversation à un collaborateur</li>
              <li>Analysez vos messages</li>
              <li>Laissez Budy répondre automatiquement</li>
              <li>Envoyez vos campagnes SMS et RCS</li>
              <li>Demandez des avis par RCS, SMS ou QR code</li>
              <li>Audit SEO et GEO</li>
              <li>Créez vos posts, réels et stories Facebook et Instagram</li>
              <li>Une alerte à chaque nouvel avis</li>
            </ul>
          </div>
          ${(instit && (instit.apps || []).length) ? `<img class="pq-app-v" src="${esc(instit.apps[0].image)}" alt="${esc(instit.apps[0].description || 'Application mobile Sofy')}" loading="lazy">` : ''}
        </div>
        <div class="pq-habs reveal">
          <div class="pq-hab"><img src="/hab-google.jpg" alt="Google" loading="lazy"><b>Google Partner</b><span>partenaire certifié Google</span></div>
          <div class="pq-hab"><img src="/hab-messages.png" alt="Google Messages" loading="lazy"><b>Partner RBM</b><span>agents RCS de marque vérifiés par Google, déployés par Sofy</span></div>
          <div class="pq-hab"><img src="/hab-arcep.jpg" alt="ARCEP" loading="lazy"><b>Déclaré ARCEP</b><span>opérateur de communications électroniques déclaré</span></div>
          <div class="pq-hab"><span class="pq-ant">((·))</span><b>Agrégateur télécom direct opérateurs</b><span>France métropolitaine &amp; outre-mer : Antilles, Guyane, La Réunion, Mayotte</span></div>
        </div>
        <div class="pq-pied reveal">
          <div class="pq-ks">
            <div class="pq-k"><b>14 ans</b><span>d'expérience, depuis 2012</span></div>
            <div class="pq-k"><b>5 000+</b><span>clients accompagnés</span></div>
            <div class="pq-k"><b>20</b><span>collaborateurs</span></div>
            <div class="pq-k"><b>4</b><span>implantations : France, La Réunion, Guadeloupe, Barcelone</span></div>
          </div>
          ${(instit && (instit.clients || []).length) ? (() => {
            const cls = instit.clients.slice(0, 24);
            const un = cls.map(c => `<span class="cli-i"><img src="${esc(c.image)}" alt="${esc(c.description || '')}" loading="lazy"></span>`).join('');
            return `<div class="pq-refs"><h3>Ils nous confient leurs points de vente</h3>
              <div class="cli-b" aria-label="Ils nous font confiance">
                <div class="cli-p" style="--dur:${Math.max(22, cls.length * 2.6).toFixed(0)}s">${un}${un}</div>
              </div></div>`;
          })() : ''}
        </div>
      </div>` : '';
  return `<section class="pl ${pq || sombre ? 'dark' : 'light'}${couv ? ' pl-couv' : ''}${pq ? ' pl-pq' : ''}" data-s="${i}">
    <div class="wrap${couv && sdr && sdr.photo ? ' wrap-couv' : ''}${pq ? ' wrap-pq' : ''}">
      <header class="pl-h">
        <img class="logo" src="/logo-full.png" alt="Sofy" width="96" height="30">
        <span class="pag">${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span>
      </header>
      ${p.role === 'couverture' ? `<div class="couv-h">
        ${logo ? `<img class="logo-p" src="${esc(logo)}" alt="">` : ''}
        <div class="couv-x">
          <span class="couv-s">Analyse Sofy</span>
          <span class="couv-p">préparée pour ${esc(p.titre || '')}</span>
          <span class="couv-w">sofy.fr</span>
        </div>
      </div>` : ''}
      ${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}
      <h2 class="pl-t">${md(p.titre)}</h2>
      <div class="rule"></div>
      ${p.couv2 ? `
      <p class="couv-acc">${md(p.couv2.accroche)}</p>
      <div class="tsrs reveal">
        <div class="tsrs-t">${p.couv2.teasers.length === 3 ? 'Trois' : 'Deux'} mesures de cette analyse</div>
        <div class="tsr">${p.couv2.teasers.map(x => `
          <div class="ts">${x.ou ? `<i>${esc(x.ou)}</i>` : ''}<b>${esc(x.valeur)}</b><span>${esc(x.label)}</span></div>`).join('')}
        </div>
      </div>
      ${p.texte ? `<p class="couv-methode">${md(p.texte)}</p>` : ''}
      <div class="couv-meta">${p.couv2.meta.map(x => `<span>${esc(x)}</span>`).join('')}</div>`
      : (p.texte ? `<p class="pl-x">${md(p.texte)}</p>` : '')}
      ${pourquoiHtml}
      ${bilan}
      ${marche}
      ${ficheG}
      ${chiffres ? `<div class="kpis">${chiffres}</div>` : ''}
      ${avisReel}
      ${(defauts && (fichesCascade || vis)) ? `<div class="df-duo">
        <div>${defauts}</div>
        <div>${vis ? `<figure class="ill ill-h reveal"><img src="${esc(vis.image)}" alt="${esc(vis.description || '')}" loading="lazy"></figure>` : fichesCascade}</div>
      </div>` : (defauts || '')}
      ${problemes ? `<div class="pbs">${problemes}</div>` : ''}
      ${duel}
      ${rcs}
      ${courbe}
      ${jalons ? `<div class="jls">${jalons}</div>` : ''}
      ${proj ? `<div class="pjs">${proj}</div>` : ''}
      ${points ? `<div class="pts">${points}</div>` : ''}
      ${cit}
      ${lienCas}
      ${couv && sdr && sdr.photo ? `<div class="portrait-bloc reveal">
        <div class="portrait"><img src="${esc(sdr.photo)}" alt="${esc(sdr.nom || '')}"></div>
        <div class="portrait-n">${esc(sdr.nom || '')}</div>
        <div class="portrait-r">${esc(sdr.poste || 'Votre interlocuteur chez Sofy')}</div>
        ${sdr.bio ? `<div class="portrait-b">${md(sdr.bio)}</div>` : ''}
      </div>` : ''}
      ${p.role === 'cta' ? `<div class="fin">
        <div class="fin-g">
          <div class="cta-zone">
            <a class="btn-demo" href="${esc(LIEN_DEMO())}" target="_blank" rel="noopener">📅 ${esc(p.cta || 'Réserver 15 minutes')}</a>
            <div class="sdr-card" id="sdr-card"></div>
          </div>
        </div>
        <div class="fin-d">
          ${/* La photo du commercial signataire plutôt que la photo d'équipe générique : le
                prospect termine sur le visage de la personne qu'il va avoir au téléphone
                (demande Didier, 26/08). La photo d'équipe reste le filet quand le SDR n'en a pas. */''}
          ${(sdr && sdr.photo) ? `<figure class="eq eq-sdr"><img src="${esc(sdr.photo)}" alt="${esc(sdr.nom || 'Votre interlocuteur Sofy')}" loading="lazy"><img class="eq-l" src="/logo-icon.png" alt=""></figure>`
            : ((instit && instit.equipe) ? `<figure class="eq"><img src="${esc(instit.equipe)}" alt="L'équipe Sofy" loading="lazy"><img class="eq-l" src="/logo-icon.png" alt=""></figure>` : '')}
          ${/* Le bandeau de logos clients vivait ici ; il a déménagé sur la planche
                « Pourquoi Sofy » (26/08) — le garder aux deux endroits était redondant. */''}
        </div>
      </div>
      <div class="rep">
        ${SOFY_REPERES.map(r => `<div class="rep-i"><b>${esc(r.c)}</b><span>${esc(r.t)}</span></div>`).join('')}
        <div class="rep-x">Sofy accompagne les réseaux à points de vente depuis 2012 : visibilité locale, messagerie clients et campagnes mobiles, avec un interlocuteur dédié.</div>
      </div>` : ''}
      <footer class="pl-f"><span>sofy.fr</span><span>${esc(p.eyebrow || '')}</span></footer>
    </div>
  </section>`;
}

// ── Impression PDF : règles de mise en page PARTAGÉES entre la feuille @media print et la
// mesure JavaScript (calcul du facteur de réduction par planche). L'impression pose son
// viewport à 794 px (largeur A4, marges @page à 0) : les media queries desktop (min-width:900)
// tombent et chaque clamp(vw) change de valeur — c'est ce qui donnait le PDF en colonne unique,
// coupé au fil des pages. Ces règles figent la mise en page desktop à 1000 px de large et
// résolvent chaque clamp à sa valeur d'impression (1 vw = 7,94 px), pour que « mesuré à
// l'écran » = « imprimé ». SOURCE UNIQUE : toute évolution du responsive (media queries,
// clamps) doit se répercuter ici, sinon le PDF re-divergera de l'écran.
const REGLES_IMPRESSION = `
.pl{width:1000px;min-height:auto;padding:40px 0}
.wrap{width:940px}
.pl-h{margin-bottom:32px}
.pl-t{font-size:43px}
.pl-couv .pl-t{font-size:59px}
.pl-x{font-size:16px}
.pl-f{margin-top:40px}
.kpi-v{font-size:35px}
.kpi-v.long{font-size:19px}
.kpi-v.moyen{font-size:24px}
.dl-kv{font-size:40px}
.wrap-couv{gap:32px}
.fin{grid-template-columns:1.05fr .95fr}
.df-duo{grid-template-columns:1.02fr .98fr}
.casc{display:block;padding-left:10px}
.casc-f{margin-top:calc(var(--i) * -14px);margin-left:calc(var(--i) * 18px);transform:scale(calc(1 - var(--i) * .03));transform-origin:top left}
.casc-p{margin-left:68px}
.rcs{grid-template-columns:312px 1fr}
.wrap-couv{grid-template-columns:1.25fr .75fr}
.wrap-couv .pl-h{grid-column:1/-1}
.wrap-couv .pl-f{grid-column:1/-1}
.wrap-couv .portrait-bloc{grid-row:2/span 6;grid-column:2}
.mk-duo{grid-template-columns:1.05fr .95fr}
.ill{max-height:230px}.ill img{max-height:230px}
.duel{grid-template-columns:1fr 62px 1.12fr}
.bd{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;position:relative}
.wrap-pq{display:grid;grid-template-columns:1.08fr .92fr;column-gap:32px}
.wrap-pq .pl-h,.wrap-pq .pq-corps,.wrap-pq .pl-f{grid-column:1/-1}
.wrap-pq .pq-coach{grid-column:2;grid-row:2/span 4;align-self:start;margin-top:0}
.pl-pq .pl-t{font-size:40px}
.pq-bande{grid-template-columns:1.3fr 1fr}
.pq-habs{grid-template-columns:repeat(4,1fr)}
.pq-pied{grid-template-columns:1fr}
.pq-ks{grid-template-columns:repeat(4,1fr)}
.pq-refs{min-width:0;max-width:100%}
.pq-app-l{grid-template-columns:repeat(3,1fr)}
.pq-app.avec-visuel{grid-template-columns:1fr 290px}
.tsr{grid-template-columns:repeat(3,1fr)}
`;

function page(doc, meta, sdr, apercu, images, instit) {
  const pl = Array.isArray(doc.planches) ? doc.planches : [];
  const contact = sdr ? [
    sdr.nom ? `<div class="sdr-n">${esc(sdr.nom)}</div>` : '',
    `<div class="sdr-r">Votre interlocuteur chez Sofy</div>`,
    sdr.email ? `<a href="mailto:${esc(sdr.email)}">${esc(sdr.email)}</a>` : '',
    sdr.ringover_numero ? `<a href="tel:${esc(String(sdr.ringover_numero).replace(/\s/g, ''))}">${esc(sdr.ringover_numero)}</a>` : '',
    `<div class="sdr-x">Répondre à l'email suffit.</div>`
  ].filter(Boolean).join('') : '';
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(doc.titre_document || 'Analyse Sofy')}</title>
<style>
:root{
 --nuit:#0F0B29; --nuit2:#1A1040; --clair:#FFFFFF; --clair2:#F4F2FD;
 --ink:#14103A; --ink-s:#5A5580; --ink-d:#F2F0FF; --ink-ds:#B9B2E0;
 --v:#5B4FE9; --r:#F0428A; --line:#E4E0F5; --line-d:rgba(255,255,255,.12);
 --grad:linear-gradient(90deg,#5B4FE9,#F0428A);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;color:var(--ink);background:var(--clair)}
.pl{min-height:100vh;display:flex;align-items:center;padding:clamp(28px,5vw,72px) 0;position:relative}
.pl.light{background:linear-gradient(150deg,#FFF 0%,#F7F5FE 55%,#FDF2F8 100%)}
.pl.dark{background:radial-gradient(120% 90% at 78% 8%,#2A1856 0%,var(--nuit2) 42%,var(--nuit) 100%);color:var(--ink-d)}
.wrap{width:min(1120px,92vw);margin:0 auto}
.pl-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:clamp(24px,4vw,54px)}
.logo{font-size:22px;font-weight:800;letter-spacing:-.03em}
.pl.light .logo{color:var(--v)} .pl.dark .logo{color:#fff}
.pag{font-size:12px;letter-spacing:.22em;font-variant-numeric:tabular-nums}
.pl.light .pag{color:#B9B2E0} .pl.dark .pag{color:rgba(255,255,255,.42)}
.eyebrow{font-size:12.5px;font-weight:700;letter-spacing:.19em;text-transform:uppercase;margin-bottom:14px}
.pl.light .eyebrow{color:var(--v)} .pl.dark .eyebrow{color:var(--r)}
.pl-t{font-size:clamp(30px,5.4vw,62px);font-weight:800;line-height:1.04;letter-spacing:-.03em;margin:0;text-wrap:balance;max-width:19ch}
.rule{height:5px;width:92px;border-radius:3px;background:var(--grad);margin:22px 0 26px}
.anim .rule{transform:scaleX(0);transform-origin:left;transition:transform .8s cubic-bezier(.22,.68,.24,1) .15s}
.anim .on .rule,.anim .wrap.on .rule{transform:scaleX(1)}
.pl-x{font-size:clamp(16px,1.5vw,20px);line-height:1.6;max-width:62ch;margin:0}
.pl.light .pl-x{color:var(--ink-s)} .pl.dark .pl-x{color:var(--ink-ds)}
.kpis{display:grid;gap:18px;margin-top:38px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.kpi{padding:24px 26px;border-radius:16px}
.pl.light .kpi{background:#fff;border:1px solid var(--line);box-shadow:0 2px 4px rgba(20,16,58,.04),0 18px 40px rgba(20,16,58,.07)}
.pl.dark .kpi{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.kpi-v{font-size:clamp(34px,4.4vw,54px);font-weight:800;letter-spacing:-.03em;line-height:1;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.kpi-l{font-size:15px;line-height:1.5;margin-top:12px}
.pl.dark .kpi-l{color:var(--ink-ds)}
.kpi-s{font-size:11.5px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line)}
.pl.light .kpi-s{color:#9990C4} .pl.dark .kpi-s{color:rgba(255,255,255,.4);border-top-color:var(--line-d)}
.pts{display:flex;flex-direction:column;gap:20px;margin-top:36px;max-width:78ch}
.pt{display:flex;gap:16px;align-items:flex-start}
.pt-n{flex:none;width:34px;height:34px;border-radius:11px;background:var(--grad);color:#fff;
 display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px}
.pt-t{font-size:18px;font-weight:750;letter-spacing:-.01em}
.pt-x{font-size:15.5px;line-height:1.6;margin-top:4px}
.pl.light .pt-x{color:var(--ink-s)} .pl.dark .pt-x{color:var(--ink-ds)}
.pt-s{font-size:11.5px;margin-top:7px}
.pl.light .pt-s{color:#9990C4} .pl.dark .pt-s{color:rgba(255,255,255,.4)}
.cit{margin:34px 0 0;padding:22px 26px;border-radius:14px;border-left:4px solid var(--r);
 font-size:17px;line-height:1.6;font-style:italic;max-width:68ch}
.pl.light .cit{background:#fff;border:1px solid var(--line);border-left:4px solid var(--r)}
.pl.dark .cit{background:rgba(255,255,255,.055);border:1px solid var(--line-d);border-left:4px solid var(--r)}
.cit cite{display:block;margin-top:12px;font-style:normal;font-size:12.5px;letter-spacing:.04em}
.pl.light .cit cite{color:#9990C4} .pl.dark .cit cite{color:rgba(255,255,255,.45)}
/* Bouton « Lire l'interview » : un lien sortant assumé, pas un bouton d'action déguisé. */
.itw{display:inline-flex;align-items:center;gap:10px;margin-top:18px;padding:11px 18px;border-radius:11px;
 text-decoration:none;font-size:14.5px;font-weight:750;background:var(--grad);color:#fff;
 box-shadow:0 10px 26px rgba(91,79,233,.28);transition:transform .18s ease,box-shadow .18s ease}
.itw:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(91,79,233,.36)}
.itw:focus-visible{outline:3px solid #F0428A;outline-offset:3px}
.itw-i{font-size:11px;opacity:.9}
.itw-x{font-size:11px;font-weight:650;opacity:.82;letter-spacing:.03em;padding-left:10px;
 border-left:1px solid rgba(255,255,255,.35)}
.fin{display:grid;gap:28px;margin-top:32px;align-items:center;grid-template-columns:1fr}
/* Sans min-width:0, une piste de logos de 2 280 px fait déborder toute la page (vu au test). */
.fin>*{min-width:0}
@media(min-width:920px){.fin{grid-template-columns:1.05fr .95fr}}
.eq{margin:0;position:relative;border-radius:16px;overflow:hidden;box-shadow:0 18px 44px rgba(20,16,58,.16)}
.eq img{width:100%;height:auto;max-height:260px;object-fit:cover;display:block}
/* Le portrait du SDR est un carré à médaillon (pensé pour la couverture) : en « cover » le
   cadre le rogne. « contain » sur fond blanc le montre entier. */
.eq-sdr{background:#fff}
.eq-sdr .eq-l{display:none}
.eq-sdr img{max-height:280px;object-fit:contain;padding:10px 0}
.eq-l{position:absolute;top:12px;right:12px;width:36px;height:36px;max-height:36px;max-width:36px;
 opacity:.95;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));border-radius:8px;
 background:rgba(255,255,255,.9);padding:4px;box-sizing:border-box}
/* Grille régulière plutôt qu'un flux : avec neuf logos, le neuvième se retrouvait seul sur une
   ligne — l'effet « oubli » plutôt que « référence ». */
.cli{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:8px;margin-top:14px}
/* Bandeau de logos qui défile. Les masques latéraux évitent l'effet « logo coupé » aux bords. */
.cli-b{margin-top:14px;overflow:hidden;position:relative;min-width:0;max-width:100%;
 mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent);
 -webkit-mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent)}
.cli-p{display:flex;gap:8px;width:max-content;animation:defile var(--dur,26s) linear infinite}
.cli-b:hover .cli-p{animation-play-state:paused}
.cli-p .cli-i{width:96px;flex:none}
/* Une copie + un écart (gap/2 = 4px) : à -50% pile, la boucle sursauterait de 4 px. */
@keyframes defile{from{transform:translate3d(0,0,0)}to{transform:translate3d(calc(-50% - 4px),0,0)}}
@media(prefers-reduced-motion:reduce){.cli-p{animation:none;flex-wrap:wrap;width:100%}}
.cli-i{height:44px;padding:6px 8px;border-radius:9px;background:#fff;display:flex;
 align-items:center;justify-content:center;border:1px solid var(--line)}
.pl.dark .cli-i{border-color:rgba(255,255,255,.14)}
.cli-i img{max-height:30px;max-width:100%;width:auto;object-fit:contain;display:block}
.rep{display:flex;flex-wrap:wrap;gap:14px 30px;align-items:flex-start;margin-top:30px;padding-top:20px;
 border-top:1px solid var(--line)}
.pl.dark .rep{border-top-color:var(--line-d)}
.rep-i{display:flex;flex-direction:column}
.rep-i b{font-size:25px;font-weight:800;letter-spacing:-.03em;line-height:1;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.rep-i span{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;margin-top:4px}
.pl.light .rep-i span{color:#9990C4} .pl.dark .rep-i span{color:rgba(255,255,255,.48)}
.rep-x{flex:1;min-width:240px;font-size:12.5px;line-height:1.55;max-width:56ch}
.pl.light .rep-x{color:var(--ink-s)} .pl.dark .rep-x{color:var(--ink-ds)}
@media print{.eq{box-shadow:none}}
.cta-zone{display:flex;gap:22px;flex-wrap:wrap;align-items:center;margin-top:38px}
.btn-demo{display:inline-block;padding:17px 30px;border-radius:13px;background:var(--grad);color:#fff;
 text-decoration:none;font-weight:750;font-size:17px;box-shadow:0 12px 32px rgba(91,79,233,.38)}
.sdr-card{font-size:14.5px;line-height:1.65}
.sdr-n{font-weight:800;font-size:17px}
.sdr-r{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--r);margin-bottom:6px}
.sdr-card a{display:block;text-decoration:none;width:fit-content;border-bottom:1px solid}
.pl.light .sdr-card a{color:var(--v);border-bottom-color:rgba(91,79,233,.35)}
.pl.dark .sdr-card a{color:#fff;border-bottom-color:rgba(255,255,255,.3)}
.sdr-x{margin-top:8px;font-size:13px}
.pl.light .sdr-x{color:var(--ink-s)} .pl.dark .sdr-x{color:var(--ink-ds)}
.pl.light .sdr-n{color:var(--ink)} .pl.dark .sdr-n{color:var(--ink-d)}
.pl-f{display:flex;justify-content:space-between;font-size:12px;margin-top:clamp(28px,5vw,60px);letter-spacing:.05em}
.pl.light .pl-f{color:#B9B2E0} .pl.dark .pl-f{color:rgba(255,255,255,.34)}
.tools{position:fixed;right:16px;bottom:16px;display:flex;gap:8px;z-index:9}
.tools button{font:inherit;font-size:13px;font-weight:650;padding:10px 15px;border-radius:11px;cursor:pointer;
 border:1px solid var(--line);background:#fff;color:var(--ink);box-shadow:0 6px 22px rgba(20,16,58,.16)}
.logo-p{max-height:54px;max-width:190px;width:auto;margin-bottom:22px;display:block;object-fit:contain}
.pl.dark .logo-p{filter:brightness(0) invert(1);opacity:.94}
.ets{display:inline-flex;gap:1px;letter-spacing:-1px}
.et{color:#DADCE0;font-size:17px;line-height:1}
.et.on{color:#FBBC04} .et.mi{color:#FBBC04;opacity:.5}
.ets.sm .et{font-size:14px}
.gmb{margin-top:32px;max-width:560px}
.gmb-w{border-radius:14px;overflow:hidden;background:#fff;border:1px solid #DADCE0;box-shadow:0 4px 10px rgba(20,16,58,.09),0 26px 54px rgba(20,16,58,.14)}
.gmb-bar{display:flex;align-items:center;gap:6px;padding:9px 13px;background:#F1F3F4;border-bottom:1px solid #DADCE0}
.gmb-d{width:9px;height:9px;border-radius:50%;background:#DADCE0}
.gmb-u{margin-left:8px;font-size:11.5px;color:#5F6368;font-family:ui-monospace,Menlo,monospace}
.gmb-b{padding:19px 21px 21px;color:#202124}
.gmb-n{font-size:21px;font-weight:650;letter-spacing:-.015em;line-height:1.2}
.gmb-r{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.gmb-note{font-size:15px;font-weight:700;color:#D93025}
.gmb-a{font-size:13.5px;color:#1A73E8}
.gmb-l{margin-top:15px;padding-top:14px;border-top:1px solid #E8EAED;display:flex;flex-direction:column;gap:9px}
.gmb-i{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.4;color:#3C4043}
.gmb-i span{flex:none;width:17px;text-align:center;opacity:.75}
.gmb-i.vide{color:#D93025;font-weight:600}
.gmb-c{font-size:12px;margin-top:10px}
.pl.light .gmb-c{color:#9990C4} .pl.dark .gmb-c{color:rgba(255,255,255,.45)}
.av{margin-top:24px;max-width:600px;border-radius:14px;padding:19px 21px}
.pl.light .av{background:#fff;border:1px solid var(--line);box-shadow:0 14px 34px rgba(20,16,58,.07)}
.pl.dark .av{background:rgba(255,255,255,.06);border:1px solid var(--line-d)}
.av-h{display:flex;align-items:center;gap:11px}
.av-av{flex:none;width:38px;height:38px;border-radius:50%;background:#5B4FE9;color:#fff;display:flex;
 align-items:center;justify-content:center;font-weight:700;font-size:16px}
.av-n{font-size:14px;font-weight:650}
.av-m{display:flex;align-items:center;gap:9px;margin-top:2px;font-size:12px}
.pl.light .av-m span{color:#9990C4} .pl.dark .av-m span{color:rgba(255,255,255,.45)}
.av-g{margin-left:auto;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.55}
.av-t{font-size:15px;line-height:1.6;margin-top:13px;font-style:italic}
.av-f{font-size:12px;margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}
.pl.dark .av-f{border-top-color:var(--line-d);color:rgba(255,255,255,.45)}
.pl.light .av-f{color:#9990C4}
.df-duo{display:grid;gap:26px;margin-top:30px;align-items:start;grid-template-columns:1fr}
@media(min-width:980px){.df-duo{grid-template-columns:1.02fr .98fr}}
.df-duo .dfs{margin-top:0}
.casc{position:relative;display:flex;flex-direction:column;gap:10px}
.casc-f{position:relative;z-index:calc(10 - var(--i));border-radius:12px;overflow:hidden;background:#fff;
 border:1px solid #DADCE0;box-shadow:0 3px 8px rgba(20,16,58,.1),0 16px 36px rgba(20,16,58,.16)}
/* La cascade (chevauchement décalé) n'a de sens qu'en grand écran : en étroit, les fiches se
   masquaient les unes les autres. */
@media(min-width:980px){
 .casc{display:block;padding-left:10px}
 .casc-f{margin-top:calc(var(--i) * -14px);margin-left:calc(var(--i) * 18px);
  transform:scale(calc(1 - var(--i) * .03));transform-origin:top left}
 .casc-p{margin-left:68px}
}
.anim .casc-f{opacity:0;transform:translateY(14px) scale(calc(1 - var(--i) * .03));
 transition:opacity .6s ease var(--d),transform .6s cubic-bezier(.22,.68,.24,1) var(--d)}
.anim .reveal.on .casc-f{opacity:1;transform:translateY(0) scale(calc(1 - var(--i) * .03))}
.casc-bar{display:flex;align-items:center;gap:5px;padding:7px 11px;background:#F1F3F4;border-bottom:1px solid #DADCE0}
.casc-bar span{width:7px;height:7px;border-radius:50%;background:#DADCE0;display:block}
.casc-bar i{margin-left:6px;font-style:normal;font-size:10.5px;color:#5F6368;font-family:ui-monospace,Menlo,monospace}
.casc-b{padding:12px 14px 13px;color:#202124}
.casc-n{font-size:15.5px;font-weight:650;letter-spacing:-.01em;line-height:1.25}
.casc-r{display:flex;align-items:center;gap:7px;margin-top:5px;flex-wrap:wrap}
.casc-r b{font-size:14px;font-weight:700;color:#D93025}
.casc-a{font-size:12.5px;color:#1A73E8}
.casc-i{font-size:12.5px;color:#3C4043;margin-top:6px;line-height:1.35}
.casc-i.casc-x{color:#D93025;font-weight:600}
.casc-p{margin-top:4px;font-size:12.5px;font-weight:600}
.pl.light .casc-p{color:var(--ink-s)} .pl.dark .casc-p{color:var(--ink-ds)}
.casc-m{margin-top:8px;font-size:12.5px;line-height:1.5;padding:9px 12px;border-radius:9px}
.pl.light .casc-m{background:#FFF4F6;border:1px solid #F7C9D8;color:#9F1239}
.pl.dark .casc-m{background:rgba(240,66,138,.12);border:1px solid rgba(240,66,138,.3);color:#FBCFE8}
.ill-h{max-height:none;aspect-ratio:4/3}
.ill-h img{max-height:none;height:100%}
@media print{.casc-f{box-shadow:none;margin-left:0;margin-top:8px;transform:none}}
.dfs{display:flex;flex-direction:column;gap:10px;margin-top:30px;max-width:76ch}
.df{display:flex;gap:12px;align-items:flex-start;padding:14px 17px;border-radius:11px;font-size:14.5px;line-height:1.5}
.pl.light .df{background:#FFF4F6;border:1px solid #F7C9D8}
.pl.dark .df{background:rgba(240,66,138,.1);border:1px solid rgba(240,66,138,.28)}
.df-x{flex:none;width:21px;height:21px;border-radius:50%;background:var(--r);color:#fff;font-size:11px;
 font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px}
.rcs{display:grid;gap:30px;margin-top:34px;align-items:center;grid-template-columns:1fr}
@media(min-width:900px){.rcs{grid-template-columns:312px 1fr}}
.tel{justify-self:center}
.tel-cadre{position:relative;width:312px;max-width:100%;border-radius:44px;padding:4px;
 background:linear-gradient(155deg,#5C5C66,#2A2A31 42%,#7A7A85);
 box-shadow:0 2px 6px rgba(0,0,0,.28),0 24px 58px rgba(20,16,58,.42),inset 0 0 0 1px rgba(255,255,255,.22)}
.tel-enc{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:9px}
.tel-hp{width:44px;height:5px;border-radius:3px;background:#1A1A1C;display:block}
.tel-cam{width:9px;height:9px;border-radius:50%;background:#1A1A1C;display:block}
.tel-ec{background:#000;border-radius:41px;overflow:hidden;padding:9px 9px 11px;color:#fff;min-height:560px;
 display:flex;flex-direction:column}
.tel-st{display:flex;justify-content:space-between;align-items:center;padding:5px 10px 9px;font-size:12.5px;font-weight:700}
.tel-ic{font-size:10.5px;letter-spacing:.5px;opacity:.9}
.tel-ic b{font-size:9.5px;background:#fff;color:#000;border-radius:4px;padding:0 3px;font-weight:800}
.tel-hd{display:flex;align-items:center;gap:8px;padding:2px 4px 10px}
.tel-back{flex:none;font-size:13px;font-weight:600;background:#1C1C1E;border-radius:14px;padding:5px 11px;color:#fff}
.tel-back b{font-weight:700}
.tel-exp{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.tel-exp img{border-radius:8px;background:#000}
.tel-nom{font-size:14px;font-weight:750;background:#1C1C1E;border-radius:13px;padding:3px 11px}
.tel-vide{flex:none;width:44px}
.tel-date{text-align:center;font-size:11px;color:#8E8E93;margin:6px 0 9px}
.carte{background:#1C1C1E;border-radius:19px;overflow:hidden;margin:0 2px}
.carte-b{position:relative;height:186px;background:linear-gradient(150deg,#3B1E8C 0%,#6B2AA8 55%,#A0247A 100%);
 background-blend-mode:normal;
 background-size:cover;background-position:center;padding:13px 14px;display:flex;flex-direction:column;gap:7px}
.carte-voile{position:absolute;inset:0;background:
 linear-gradient(180deg,rgba(30,14,70,.82) 0%,rgba(59,30,140,.42) 52%,rgba(160,36,122,.34) 100%)}
.tel-av{width:34px;height:34px;border-radius:9px;background:#fff;display:flex;align-items:center;
 justify-content:center;overflow:hidden;flex:none}
.tel-av img{max-width:28px;max-height:28px;width:auto;height:auto;object-fit:contain}
.tel-av-i{background:var(--grad);color:#fff;font-size:16px;font-weight:800}
.carte-marque{position:relative;z-index:1;align-self:flex-start;background:#fff;border-radius:9px;
 padding:5px 9px;display:flex;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.carte-marque img{max-height:20px;max-width:104px;width:auto;object-fit:contain;display:block}
.carte-marque-t{font-size:13px;font-weight:800;color:#14103A;letter-spacing:-.01em}
.carte-h{position:relative;z-index:1;font-size:23px;font-weight:800;line-height:1.1;letter-spacing:-.025em;
 color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.55);max-width:15ch}
.carte-c{position:relative;padding:13px 15px 12px}
.carte-t{font-size:15px;font-weight:750;line-height:1.25;color:#fff;padding-right:18px}
.carte-x{font-size:13px;line-height:1.42;color:#8E8E93;margin-top:5px;padding-right:18px;
 display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.carte-fl{position:absolute;right:13px;top:50%;transform:translateY(-50%);color:#8E8E93;font-size:19px}
.carte-btn{margin:0 11px 11px;text-align:center;font-size:14.5px;font-weight:650;color:#fff;
 background:#2C2C2E;border:.5px solid #3A3A3C;border-radius:13px;padding:11px 12px;
 display:flex;align-items:center;justify-content:center;gap:7px}
.carte-btn::after{content:'›';font-size:17px;font-weight:400;color:#8E8E93;line-height:1}
.tel-saisie{display:flex;align-items:center;gap:8px;margin-top:auto;padding:10px 4px 2px}
.tel-plus{flex:none;width:29px;height:29px;border-radius:50%;background:#1C1C1E;color:#8E8E93;
 display:flex;align-items:center;justify-content:center;font-size:17px}
.tel-champ{flex:1;background:#1C1C1E;border-radius:15px;padding:6px 12px;display:flex;flex-direction:column}
.tel-champ i{font-style:normal;font-size:11.5px;color:#8E8E93;border-bottom:1px solid #2C2C2E;padding-bottom:3px}
.tel-champ b{font-size:11.5px;font-weight:400;color:#8E8E93;padding-top:3px}
.rcs-n{font-size:12.5px;line-height:1.5;margin-top:11px;padding:10px 13px;border-radius:9px}
.pl.light .rcs-n{background:#FEF6E7;border:1px solid #E9C88B;color:#7A4E12}
.pl.dark .rcs-n{background:rgba(224,162,83,.12);border:1px solid rgba(224,162,83,.32);color:#E9C88B}
@media print{.tel-cadre{box-shadow:none}}
.rcs-t{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:9px}
.pl.light .rcs-t{color:var(--v)} .pl.dark .rcs-t{color:var(--r)}
.rcs-x{font-size:14.5px;line-height:1.6;max-width:52ch}
.pl.light .rcs-x{color:var(--ink-s)} .pl.dark .rcs-x{color:var(--ink-ds)}
@media print{.tel{box-shadow:none}.gmb-w{box-shadow:none}}
.wrap-couv{display:grid;gap:clamp(24px,4vw,52px);align-items:center;grid-template-columns:1fr}
@media(min-width:900px){.wrap-couv{grid-template-columns:1.25fr .75fr}
 .wrap-couv .pl-h{grid-column:1/-1}
 .wrap-couv .pl-f{grid-column:1/-1}
 .wrap-couv .portrait-bloc{grid-row:2/span 6;grid-column:2}}
.portrait img{width:100%;height:100%;object-fit:cover;display:block}
@media print{.portrait-bloc{max-width:220px}}
.couv-s{font-size:27px}
.couv-p{font-size:14.5px;margin-top:1px}
.couv-w{font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-top:5px;opacity:.75}
.pl.light .couv-w{color:var(--v)} .pl.dark .couv-w{color:var(--r)}
.couv-h{gap:20px}
.logo{height:30px;width:auto;display:block}
.pl.dark .logo{filter:brightness(0) invert(1);opacity:.95}
.pl-couv .pl-t{font-size:clamp(40px,7.4vw,86px)}
.portrait-bloc{display:flex;flex-direction:column;align-items:center;text-align:center;
 justify-self:center;align-self:center;width:100%;max-width:340px}
.portrait{position:relative;border-radius:20px;overflow:hidden;width:100%;aspect-ratio:4/5}
.portrait-n{font-size:19px;font-weight:800;letter-spacing:-.02em;margin-top:14px}
.portrait-r{font-size:13.5px;line-height:1.4;margin-top:3px}
.pl.light .portrait-r{color:var(--ink-s)} .pl.dark .portrait-r{color:var(--ink-ds)}
.portrait-b{font-size:12.5px;line-height:1.5;margin-top:8px;max-width:34ch}
.pl.light .portrait-b{color:#9990C4} .pl.dark .portrait-b{color:rgba(255,255,255,.5)}
.bul-img{width:100%;height:118px;object-fit:cover;display:block;border-radius:11px;margin-bottom:10px}
.couv-h{display:flex;align-items:center;gap:16px;margin-bottom:26px;flex-wrap:wrap}
.logo-p{max-height:52px;max-width:170px;width:auto;display:block;object-fit:contain}
.couv-x{display:flex;flex-direction:column;padding-left:16px;border-left:2px solid var(--line)}
.pl.dark .couv-x{border-left-color:var(--line-d)}
.couv-s{font-size:19px;font-weight:800;letter-spacing:-.02em;background:var(--grad);
 -webkit-background-clip:text;background-clip:text;color:transparent}
.couv-p{font-size:12.5px;letter-spacing:.04em}
.pl.light .couv-p{color:var(--ink-s)} .pl.dark .couv-p{color:var(--ink-ds)}
.ae{display:flex;align-items:center;gap:15px;margin-top:34px;padding:16px 20px;border-radius:14px;max-width:430px}
.pl.light .ae{background:#fff;border:1px solid var(--line);box-shadow:0 12px 30px rgba(20,16,58,.07)}
.pl.dark .ae{background:rgba(255,255,255,.06);border:1px solid var(--line-d)}
.ae-p,.ae-i{flex:none;width:62px;height:62px;border-radius:50%;object-fit:cover}
.ae-i{display:flex;align-items:center;justify-content:center;background:var(--grad);color:#fff;font-size:24px;font-weight:800}
.ae-n{font-size:16.5px;font-weight:750;letter-spacing:-.01em}
.ae-r{font-size:12.5px;margin-top:1px}
.pl.light .ae-r{color:#9990C4} .pl.dark .ae-r{color:rgba(255,255,255,.48)}
.ae-c{display:block;font-size:13px;margin-top:3px;text-decoration:none}
.pl.light .ae-c{color:var(--v)} .pl.dark .ae-c{color:#B9B2E0}
.mk{margin-top:28px}
.mk-q{font-size:14px;margin-bottom:16px}
.pl.light .mk-q{color:var(--ink-s)} .pl.dark .mk-q{color:var(--ink-ds)}
.mk-duo{display:grid;gap:16px;grid-template-columns:1fr}
@media(min-width:900px){.mk-duo{grid-template-columns:1.05fr .95fr}}
.mk-pod,.mk-ia{padding:20px 22px;border-radius:15px}
.pl.light .mk-pod,.pl.light .mk-ia{background:#fff;border:1px solid var(--line);box-shadow:0 14px 34px rgba(20,16,58,.06)}
.pl.dark .mk-pod,.pl.dark .mk-ia{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.mk-lab{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:13px}
.pl.light .mk-lab{color:var(--v)} .pl.dark .mk-lab{color:var(--r)}
.mk-l{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
.mk-l:first-of-type{border-top:0}
.pl.dark .mk-l{border-top-color:var(--line-d)}
.mk-r{flex:none;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;
 font-size:12px;font-weight:800;background:var(--line);color:var(--ink)}
.mk-r.r1{background:linear-gradient(135deg,#F5C451,#E0A253);color:#4A2F05}
.mk-r.r2{background:#D8D4E8;color:#3F3A5C} .mk-r.r3{background:#E7C9AE;color:#5A3A22}
.mk-r.moi{background:var(--r);color:#fff}
.mk-n{flex:1;font-size:14.5px;font-weight:650;line-height:1.3}
.mk-no{font-size:14px;font-weight:750;font-variant-numeric:tabular-nums}
.mk-no i{font-style:normal;font-size:.8em;color:#F5C451;margin-left:1px}
.mk-av{font-size:12px}
.pl.light .mk-av{color:#9990C4} .pl.dark .mk-av{color:rgba(255,255,255,.45)}
.mk-moi{border-top:1px dashed var(--r);margin-top:4px}
.mk-vous{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--r)}
.mk-abs{margin-top:12px;padding:11px 13px;border-radius:10px;font-size:13.5px;line-height:1.45}
.pl.light .mk-abs{background:#FFF4F6;border:1px solid #F7C9D8;color:#9F1239}
.pl.dark .mk-abs{background:rgba(240,66,138,.12);border:1px solid rgba(240,66,138,.3);color:#FBCFE8}
.mk-ok{font-size:17px;font-weight:750;color:#0F9D6E}
.mk-non{font-size:19px;font-weight:800;letter-spacing:-.02em;color:var(--r)}
.mk-cites{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
.mk-cites span{font-size:12px;font-weight:650;padding:4px 9px;border-radius:7px}
.pl.light .mk-cites span{background:#F4F2FD;border:1px solid var(--line);color:var(--ink-s)}
.pl.dark .mk-cites span{background:rgba(255,255,255,.07);border:1px solid var(--line-d);color:var(--ink-ds)}
.mk-ads,.mk-ap{margin-top:14px;padding:16px 20px;border-radius:14px}
.pl.light .mk-ads,.pl.light .mk-ap{background:#fff;border:1px solid var(--line)}
.pl.dark .mk-ads,.pl.dark .mk-ap{background:rgba(255,255,255,.05);border:1px solid var(--line-d)}
.mk-ax{font-size:13.5px;line-height:1.55;margin-top:8px}
.pl.light .mk-ax{color:var(--ink-s)} .pl.dark .mk-ax{color:var(--ink-ds)}
.mk-al{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
.mk-ai{font-size:12.5px;font-weight:650;padding:5px 10px;border-radius:8px;display:inline-flex;align-items:center;gap:6px}
.pl.light .mk-ai{background:#FFF8E7;border:1px solid #EBD9A8;color:#7A5312}
.pl.dark .mk-ai{background:rgba(245,196,81,.13);border:1px solid rgba(245,196,81,.32);color:#F7DFA8}
.mk-ai b{font-variant-numeric:tabular-nums}
.mk-ai i{font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.75}
.mk-ix{font-size:13px;line-height:1.55;margin-top:11px}
.pl.light .mk-ix{color:var(--ink-s)} .pl.dark .mk-ix{color:var(--ink-ds)}
.bl-h{display:grid;gap:14px;margin-top:30px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.bl-k{padding:15px 17px;border-radius:12px}
.pl.light .bl-k{background:#fff;border:1px solid var(--line)}
.pl.dark .bl-k{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.bl-k b{display:block;font-size:31px;font-weight:800;letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums}
.bl-k b i{font-size:.55em;font-style:normal;margin-left:2px}
.bl-k span{display:block;font-size:12px;line-height:1.35;margin-top:6px}
.pl.light .bl-k span{color:var(--ink-s)} .pl.dark .bl-k span{color:var(--ink-ds)}
.axes{display:grid;gap:16px;margin-top:22px;grid-template-columns:repeat(auto-fit,minmax(265px,1fr))}
.ax{padding:20px 22px;border-radius:15px}
.pl.light .ax{background:#fff;border:1px solid var(--line);box-shadow:0 14px 34px rgba(20,16,58,.06)}
.pl.dark .ax{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.ax-j{position:relative;width:120px;height:120px;margin:0 auto 12px}
.ax-s{width:120px;height:120px;transform:rotate(-90deg)}
.ax-f{fill:none;stroke:var(--line);stroke-width:9}
.pl.dark .ax-f{stroke:rgba(255,255,255,.1)}
.ax-v{fill:none;stroke-width:9;stroke-linecap:round;stroke-dasharray:var(--c);stroke-dashoffset:var(--o)}
.ax-v.ok{stroke:#0F9D6E} .ax-v.moy{stroke:#E0A253} .ax-v.bas{stroke:var(--r)} .ax-v.nc{stroke:var(--line)}
.anim .ax-v{stroke-dashoffset:var(--c);transition:stroke-dashoffset 1.4s cubic-bezier(.3,.05,.2,1) .2s}
.anim .reveal.on .ax-v{stroke-dashoffset:var(--o)}
.ax-n{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:1px}
.ax-n b{font-size:33px;font-weight:800;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.ax-n i{font-size:13px;font-style:normal;opacity:.5}
.ax-t{font-size:17px;font-weight:750;text-align:center;letter-spacing:-.01em}
.ax-m{font-size:12px;text-align:center;margin-top:4px}
.pl.light .ax-m{color:#9990C4} .pl.dark .ax-m{color:rgba(255,255,255,.45)}
.ax-vd{font-weight:800;text-transform:uppercase;letter-spacing:.06em;font-size:10.5px}
.ax-vd.ok{color:#0F9D6E} .ax-vd.moy{color:#B45309} .ax-vd.bas{color:var(--r)} .ax-vd.nc{opacity:.6}
.ax-c{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.pl.dark .ax-c{border-top-color:var(--line-d)}
.ax-l{display:flex;gap:9px;font-size:12.5px;line-height:1.4;align-items:flex-start}
.ax-l b{font-weight:700}
.ax-p{flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px;background:var(--line)}
.ax-l.ok .ax-p{background:#0F9D6E} .ax-l.moyen .ax-p{background:#E0A253}
.ax-l.faible .ax-p{background:var(--r)} .ax-l.inconnu .ax-p{background:none;border:1.5px dashed #B9B2E0}
.ax-l.inconnu{opacity:.72}
/* Le bloc des points non vérifiables : séparé, sourd, sans code couleur d'évaluation. Il doit se
   lire comme une liste de sujets à ouvrir en rendez-vous, pas comme une suite de manques. */
/* Pourquoi un axe n'est pas noté : dit sous le verdict, pas dans une note de bas de page. Un « — »
   sans explication se lit comme un oubli ; expliqué, il devient la raison d'ouvrir le sujet. */
.ax-pq{font-size:11.5px;line-height:1.45;opacity:.6;margin-top:6px;text-align:center}
.ax-nv{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line);display:flex;flex-direction:column;gap:7px}
.ax-nv-t{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:650;opacity:.55;margin-bottom:1px}
.ax-nv .ax-l{opacity:.6}
.ax-nv .ax-l .ax-p{background:none;border:1.5px dashed currentColor;opacity:.5}
.ax-w{font-size:12.5px;line-height:1.5;margin-top:16px;padding:12px 15px;border-radius:10px}
.pl.light .ax-w{background:#FEF6E7;border:1px solid #E9C88B;color:#7A4E12}
.pl.dark .ax-w{background:rgba(224,162,83,.12);border:1px solid rgba(224,162,83,.34);color:#E9C88B}
@media print{.ax,.bl-k,.ae{box-shadow:none}}
.ill{margin:30px 0 0;border-radius:16px;overflow:hidden;max-height:280px}
.ill img{width:100%;height:100%;max-height:280px;object-fit:cover;display:block}
@media(min-width:900px){.ill{max-height:230px}.ill img{max-height:230px}}
@media print{.ill{max-height:150px}.ill img{max-height:150px}}
.duel{display:grid;gap:14px;margin-top:34px;align-items:stretch;grid-template-columns:1fr}
@media(min-width:900px){.duel{grid-template-columns:1fr 62px 1.12fr}}
.dl-p,.dl-s{border-radius:16px;padding:22px 24px;display:flex;flex-direction:column;gap:9px}
.pl.light .dl-p{background:#FFF4F6;border:1px solid #F7C9D8}
.pl.dark .dl-p{background:rgba(240,66,138,.09);border:1px solid rgba(240,66,138,.3)}
.pl.light .dl-s{background:#fff;border:1px solid var(--line);box-shadow:0 3px 6px rgba(20,16,58,.05),0 22px 46px rgba(91,79,233,.13)}
.pl.dark .dl-s{background:rgba(91,79,233,.16);border:1px solid rgba(139,124,255,.34)}
.dl-lab{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--r)}
.dl-lab-s{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.dl-c{font-size:17px;font-weight:650;line-height:1.4}
.dl-cout{font-size:14px;line-height:1.5;margin-top:auto;padding-top:11px;border-top:1px dashed #F0A9C0}
.pl.dark .dl-cout{border-top-color:rgba(240,66,138,.32)}
.dl-cout span{display:block;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--r);margin-bottom:3px}
.dl-n{font-size:19px;font-weight:800;letter-spacing:-.015em;line-height:1.22}
.dl-m{margin:2px 0 0;padding:0;list-style:none;counter-reset:m}
.dl-m li{counter-increment:m;position:relative;padding-left:29px;font-size:14px;line-height:1.5;margin:9px 0}
.dl-m li::before{content:counter(m);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:50%;
 background:var(--grad);color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center}
.dl-r{margin-top:auto;padding-top:12px;border-top:1px solid var(--line);font-size:15px;font-weight:650;line-height:1.45}
.pl.dark .dl-r{border-top-color:var(--line-d)}
.dl-r span{display:block;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
/* Budy entre les deux cartes. Caché en colonne unique (le duel s'empile, il n'y a plus d'entre-deux). */
.bd{display:none}
@media(min-width:900px){.bd{display:flex;flex-direction:column;align-items:center;justify-content:center;
 gap:7px;position:relative}}
.bd::before{content:'';position:absolute;left:-2px;right:-2px;top:calc(50% - 15px);height:2px;
 background:var(--grad);opacity:.4}
/* Le point d'énergie : il part du problème et entre dans Budy. */
.bd::after{content:'';position:absolute;left:0;top:calc(50% - 18px);width:8px;height:8px;border-radius:50%;
 background:var(--r);box-shadow:0 0 10px rgba(240,66,138,.75);animation:bdflux 2.8s ease-in-out infinite}
@keyframes bdflux{0%{left:-4px;opacity:0}18%{opacity:1}46%{left:calc(50% - 4px);opacity:.9}
 62%{left:calc(50% - 4px);opacity:0}72%{opacity:0}88%{left:calc(100% - 4px);opacity:.85}100%{opacity:0}}
.bd-r{width:72px;height:72px;position:relative;z-index:1;filter:drop-shadow(0 6px 16px rgba(20,16,58,.28))}
.bd-halo{fill:none;stroke:#5B4FE9;stroke-width:1.5;animation:bdpuls 3s ease-in-out infinite}
@keyframes bdpuls{0%,100%{opacity:.1;transform:scale(.9);transform-origin:32px 32px}
 50%{opacity:.38;transform:scale(1);transform-origin:32px 32px}}
.bd-ant{animation:bdant 3s ease-in-out infinite}
@keyframes bdant{0%,100%{opacity:.45}50%{opacity:1}}
.bd-y{animation:bdcil 4.6s steps(1,end) infinite;transform-origin:32px 30.5px}
@keyframes bdcil{0%,95%{transform:scaleY(1)}96%,98%{transform:scaleY(.12)}99%,100%{transform:scaleY(1)}}
.bd-n{position:relative;z-index:1;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;
 padding:3px 8px;border-radius:20px;background:var(--grad);color:#fff;white-space:nowrap}
@media(prefers-reduced-motion:reduce){.bd::after,.bd-halo,.bd-ant,.bd-y{animation:none}.bd::after{opacity:0}}
.dl-k{display:flex;align-items:center;gap:18px;margin-top:20px;padding:18px 22px;border-radius:14px;flex-wrap:wrap}
.pl.light .dl-k{background:#F4F2FD;border:1px solid var(--line)}
.pl.dark .dl-k{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.dl-kv{font-size:clamp(34px,5vw,54px);font-weight:800;letter-spacing:-.035em;line-height:1;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.dl-kl{font-size:14.5px;line-height:1.45;max-width:46ch}
.dl-kl span{display:block;font-size:11.5px;margin-top:4px}
.pl.light .dl-kl span{color:#9990C4} .pl.dark .dl-kl span{color:rgba(255,255,255,.45)}
.crb{margin-top:34px;max-width:1000px}
.crb-h{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center}
.crb-i{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.pl.light .crb-i{color:var(--v)} .pl.dark .crb-i{color:var(--r)}
.crb-i i{flex:none;width:16px;height:4px;border-radius:2px}
.crb-d1{background:linear-gradient(90deg,#5B4FE9,#F0428A)}
.crb-d2{background:repeating-linear-gradient(90deg,#12A594 0 6px,transparent 6px 10px)}
/* La seconde courbe est en pointillés : on anime son opacité, pas son tracé — sinon le
   stroke-dasharray de l'animation écraserait le pointillé. */
.anim .crb-l2{opacity:0;transition:opacity 1s ease .9s}
.reveal.on .crb-l2{opacity:1}
.crb-v2{font-size:16px;font-weight:800;text-anchor:middle;font-variant-numeric:tabular-nums;fill:#0E8074}
.pl.dark .crb-v2{fill:#5FE3D2}
.crb-s{width:100%;height:auto;margin-top:8px;overflow:visible}
.crb-g{stroke:var(--line);stroke-width:1}
.pl.dark .crb-g{stroke:rgba(255,255,255,.11)}
.anim .crb-l{stroke-dasharray:1400;stroke-dashoffset:1400;transition:stroke-dashoffset 1.8s cubic-bezier(.4,.05,.2,1) .25s}
.reveal.on .crb-l{stroke-dashoffset:0}
.anim .crb-a{opacity:0;transition:opacity .9s ease 1.1s}
.reveal.on .crb-a{opacity:1}
.anim .crb-pt{opacity:0;transition:opacity .45s ease var(--d)}
.reveal.on .crb-pt{opacity:1}
.crb-v{font-size:20px;font-weight:800;text-anchor:middle;font-variant-numeric:tabular-nums;fill:var(--ink)}
.pl.dark .crb-v{fill:var(--ink-d)}
.crb-x{font-size:14px;text-anchor:middle;fill:#9990C4}
.pl.dark .crb-x{fill:rgba(255,255,255,.45)}
/* L'hypothèse de calcul, écrite sous la courbe : un prospect a le droit de savoir d'où sort
   la pente qu'on lui montre — et c'est ce qui rend le chiffre défendable en rendez-vous. */
.crb-hy{font-size:11.5px;line-height:1.55;margin-top:9px;padding-left:11px;max-width:96ch;
 border-left:2px solid var(--line)}
.pl.light .crb-hy{color:#9990C4} .pl.dark .crb-hy{color:rgba(255,255,255,.42);border-left-color:var(--line-d)}
.crb-s2{font-size:12.5px;line-height:1.5;margin-top:10px}
.pl.light .crb-s2{color:#9990C4} .pl.dark .crb-s2{color:rgba(255,255,255,.45)}
.jls{display:grid;gap:12px;margin-top:30px;grid-template-columns:repeat(auto-fit,minmax(215px,1fr))}
.jl{padding:16px 18px;border-radius:12px;border-top:3px solid transparent;border-image:var(--grad) 1;border-image-slice:1}
.pl.light .jl{background:#fff;border:1px solid var(--line);border-top:3px solid #5B4FE9}
.pl.dark .jl{background:rgba(255,255,255,.05);border:1px solid var(--line-d);border-top:3px solid var(--r)}
.jl-q{font-size:11.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}
.pl.light .jl-q{color:var(--v)} .pl.dark .jl-q{color:var(--r)}
.jl-t{font-size:13.5px;line-height:1.5}
.pl.light .jl-t{color:var(--ink-s)} .pl.dark .jl-t{color:var(--ink-ds)}
.pbs{display:grid;gap:16px;margin-top:34px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.pb{padding:22px 24px;border-radius:15px;border-left:4px solid var(--r)}
.pl.light .pb{background:#fff;border:1px solid var(--line);border-left:4px solid var(--r);box-shadow:0 14px 34px rgba(20,16,58,.06)}
.pl.dark .pb{background:rgba(255,255,255,.055);border:1px solid var(--line-d);border-left:4px solid var(--r)}
.pb-t{font-size:17px;font-weight:750;letter-spacing:-.01em;line-height:1.25}
.pb-x{font-size:14.5px;line-height:1.55;margin-top:7px}
.pl.light .pb-x{color:var(--ink-s)} .pl.dark .pb-x{color:var(--ink-ds)}
.pb-i{font-size:13px;font-weight:700;margin-top:11px;padding-top:10px;border-top:1px dashed var(--line);color:var(--r)}
.pl.dark .pb-i{border-top-color:var(--line-d)}
.pjs{display:flex;flex-direction:column;gap:26px;margin-top:36px;max-width:74ch}
.pj-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:11px}
.pj-n{font-size:17px;font-weight:750}
.pj-d{font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.pl.light .pj-d{color:var(--v)} .pl.dark .pj-d{color:var(--r)}
.pj-row{display:flex;align-items:center;gap:13px;margin:7px 0}
.pj-lab{flex:none;width:78px;font-size:12px;text-align:right}
.pl.light .pj-lab{color:#9990C4} .pl.dark .pj-lab{color:rgba(255,255,255,.45)}
.pj-bar{flex:1;height:15px;border-radius:8px;overflow:hidden}
.pl.light .pj-bar{background:#EDEAF9} .pl.dark .pj-bar{background:rgba(255,255,255,.09)}
.pj-bar i{display:block;height:100%;width:var(--w);border-radius:8px}
.anim .pj-bar i{width:0;transition:width 1.15s cubic-bezier(.22,.68,.24,1)}
.pj-bar i.now{background:#B9B2E0}
.pl.dark .pj-bar i.now{background:rgba(255,255,255,.32)}
.pj-bar i.goal{background:var(--grad);transition-delay:.28s}
.reveal.on .pj-bar i{width:var(--w)}
.pj-v{flex:none;width:74px;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.pj-v.goal-v{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:18px}
.pj-s{font-size:12px;line-height:1.5;margin-top:9px}
.pl.light .pj-s{color:#9990C4} .pl.dark .pj-s{color:rgba(255,255,255,.42)}
.pt-r{font-size:12.5px;margin-top:6px;font-weight:650}
.pl.light .pt-r{color:var(--v)} .pl.dark .pt-r{color:var(--r)}
.kpi-u{font-size:.5em;margin-left:2px}
/* Une « valeur » longue (l'IA y met parfois une phrase) : on descend la taille au lieu de la
   couper. Un chiffre tronqué en «  d'établissem » est pire qu'un texte plus petit. */
.kpi-v.long{font-size:clamp(19px,2vw,25px);letter-spacing:-.015em;line-height:1.22}
.kpi-v.moyen{font-size:clamp(24px,2.8vw,34px);line-height:1.14}
.apercu{position:fixed;left:14px;bottom:14px;z-index:50;background:#14103A;color:#fff;font-size:12.5px;
 padding:8px 13px;border-radius:9px;max-width:min(360px,86vw);line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.28)}
@media print{.apercu{display:none}}
.anim .reveal{opacity:0;transform:translateY(20px);transition:opacity .75s ease var(--d,0ms),transform .75s cubic-bezier(.22,.68,.24,1) var(--d,0ms)}
.anim .reveal.on,.reveal.on{opacity:1;transform:none}
.rule{transform:scaleX(0);transform-origin:left;transition:transform .8s cubic-bezier(.22,.68,.24,1) .15s}
.on .rule{transform:scaleX(1)}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}}
/* ── Couverture v2 : accroche + teasers mesurés ── */
.couv-acc{font-size:clamp(17px,1.8vw,21px);line-height:1.5;max-width:56ch;margin:0;font-weight:600}
.couv-acc strong{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.tsrs{margin-top:24px}
.tsrs-t{font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#9990C4;margin-bottom:10px}
.tsr{display:grid;grid-template-columns:1fr;gap:12px;max-width:660px}
@media(min-width:760px){.tsr{grid-template-columns:repeat(3,1fr)}}
.ts{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px;position:relative;
 box-shadow:0 2px 4px rgba(20,16,58,.04),0 14px 30px rgba(20,16,58,.06)}
.ts b{display:block;font-size:26px;font-weight:800;letter-spacing:-.03em;line-height:1;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.ts span{display:block;font-size:12px;color:var(--ink-s);margin-top:6px;line-height:1.45}
.ts i{position:absolute;top:12px;right:14px;font-style:normal;font-size:11px;color:#9990C4}
.couv-methode{font-size:13px;color:#9990C4;line-height:1.55;max-width:60ch;margin:16px 0 0}
.couv-meta{display:flex;gap:18px;flex-wrap:wrap;margin-top:22px;font-size:12.5px;color:var(--ink-s)}
.couv-meta span{display:flex;align-items:center;gap:6px}
.couv-meta span::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--grad)}

/* ── Planche « Pourquoi Sofy » ── */
@media(min-width:900px){
 .wrap-pq{display:grid;grid-template-columns:1.08fr .92fr;column-gap:clamp(22px,3vw,44px)}
 .wrap-pq .pl-h,.wrap-pq .pq-corps,.wrap-pq .pl-f{grid-column:1/-1}
 .wrap-pq .pq-coach{grid-column:2;grid-row:2/span 4;align-self:start}
}
.pl-pq .pl-t{font-size:clamp(28px,4.1vw,48px);max-width:22ch}
.pq-coach{background:rgba(255,255,255,.06);border:1px solid var(--line-d);border-radius:18px;padding:22px 24px;margin-top:14px}
@media(min-width:900px){.pq-coach{margin-top:0}}
.pq-ch{display:flex;gap:14px;align-items:center;margin-bottom:12px}
.pq-ch img{width:64px;height:64px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 3px #5B4FE9,0 0 0 5px rgba(240,66,138,.55)}
.pq-ch b{display:block;font-size:17px;color:#fff}
.pq-ch span{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--r);font-weight:700}
.pq-li{display:flex;gap:11px;align-items:flex-start;padding:9px 0;border-top:1px solid rgba(255,255,255,.08)}
.pq-li img{width:22px;height:22px;object-fit:contain;flex:none;margin-top:2px;border-radius:5px}
.pq-li b{display:block;font-size:14.5px;color:#fff}
.pq-li span{font-size:13px;line-height:1.5;color:var(--ink-ds)}
.pq-pt{flex:none;width:22px;height:22px;border-radius:50%;background:var(--grad);margin-top:2px}
.pq-bande{display:grid;grid-template-columns:1fr;gap:10px;margin-top:clamp(18px,2.5vw,26px)}
@media(min-width:760px){.pq-bande{grid-template-columns:1.3fr 1fr}}
.pq-bande figure{margin:0;border-radius:14px;overflow:hidden;position:relative;border:1px solid rgba(255,255,255,.14);height:190px}
.pq-bande img{width:100%;height:100%;object-fit:cover;display:block}
.pq-bande figcaption{position:absolute;left:0;right:0;bottom:0;padding:20px 12px 8px;font-size:11px;color:#fff;
 background:linear-gradient(transparent,rgba(15,11,41,.88))}
/* Le visuel de l'app est un PNG DÉTOURÉ (fond transparent) : il se pose sur le dégradé de la
   carte sans raccord. Si un visuel non détouré arrive en base, il jurera — le déposer détouré. */
.pq-app{background:linear-gradient(180deg,#4c1fc2 0%,#4616b0 40%,#52209a 100%);
 border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:18px 22px;margin-top:clamp(16px,2.5vw,24px)}
.pq-app.avec-visuel{display:grid;grid-template-columns:1fr;gap:16px;align-items:center}
@media(min-width:860px){.pq-app.avec-visuel{grid-template-columns:1fr 290px}}
.pq-app-v{width:100%;max-height:235px;object-fit:contain;justify-self:center}
.pq-app-h{display:flex;gap:13px;align-items:center;margin-bottom:12px}
.pq-app-h img{width:44px;height:44px;border-radius:11px;background:#fff;padding:6px;object-fit:contain}
.pq-app-h b{display:block;font-size:15.5px;color:#fff;letter-spacing:-.01em}
.pq-app-h span{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--r);font-weight:700}
/* La note du store (relevée sur la fiche App Store — à rafraîchir à la main quand elle bouge) */
.pq-note{display:block;font-style:normal;font-size:13.5px;font-weight:750;color:#fff;margin-top:3px}
.pq-note i{font-style:normal;color:#F5C451;letter-spacing:.06em}
.pq-app-l{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:1fr;gap:7px 22px;font-size:13px;color:var(--ink-ds)}
@media(min-width:860px){.pq-app-l{grid-template-columns:repeat(3,1fr)}}
.pq-app-l li{padding-left:19px;position:relative;line-height:1.45}
.pq-app-l li::before{content:'';position:absolute;left:0;top:6px;width:9px;height:9px;border-radius:50%;
 background:var(--grad)}
.pq-habs{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:clamp(16px,2.5vw,24px)}
@media(min-width:860px){.pq-habs{grid-template-columns:repeat(4,1fr)}}
.pq-hab{background:#fff;color:var(--ink);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;min-height:96px}
.pq-hab img{height:26px;width:auto;align-self:flex-start;object-fit:contain}
.pq-hab b{font-size:14px;letter-spacing:-.01em}
.pq-hab span{font-size:11.5px;color:var(--ink-s);line-height:1.4}
.pq-ant{height:26px;display:flex;align-items:center;font-size:19px;font-weight:800;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.pq-pied{display:grid;grid-template-columns:1fr;gap:clamp(14px,2vw,20px);margin-top:clamp(16px,2.5vw,24px);align-items:start}
.pq-ks{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
@media(min-width:860px){.pq-ks{grid-template-columns:repeat(4,1fr)}}
.pq-k b{display:block;font-size:27px;font-weight:800;letter-spacing:-.03em;line-height:1;white-space:nowrap;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.pq-k span{display:block;font-size:11.5px;color:var(--ink-ds);margin-top:5px;line-height:1.4;max-width:24ch}
.pq-refs{min-width:0;max-width:100%}
.pq-refs h3{margin:0 0 4px;font-size:11.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-ds)}
@page{size:210mm 297mm;margin:0}
@media print{
 ${REGLES_IMPRESSION}
 .tools,.apercu{display:none!important}
 html,body{background:#fff!important}
 /* Les couleurs et fonds sont le document lui-même (chiffres en dégradé, maquettes, badges) :
    on force leur impression même si « Imprimer les arrière-plans » est décoché. */
 :root{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
 /* Les ombres portées et text-shadows sortent en pavés gris dans les PDF (Safari surtout). */
 *{box-shadow:none!important;text-shadow:none!important;animation:none!important;transition:none!important}
 /* Une planche = une page A4 : posée à 1000 px (mise en page desktop, cf. REGLES_IMPRESSION)
    puis réduite par zoom pour tenir dans 210×297 mm. --pz est calculé par planche côté client ;
    .794 = 794/1000, la valeur exacte quand rien ne déborde en hauteur. */
 .pl{break-after:page;page-break-after:always;background:#fff!important;color:#14103A!important;zoom:var(--pz,.794);margin-left:auto;margin-right:auto}
 .pl:last-of-type{break-after:auto;page-break-after:auto}
 /* Thème sombre → clair : le papier est blanc (préparerImpression() bascule aussi les classes,
    ces règles restent le filet quand l'impression part sans JavaScript). */
 .pl.dark .pl-t,.pl.dark .kpi-l,.pl.dark .pt-x,.pl.dark .pl-x{color:#14103A!important}
 .pl.dark .kpi,.pl.dark .cit{background:#F7F5FE!important;border-color:#E4E0F5!important}
 .pl.dark .logo,.pl.dark .logo-p{filter:none!important;opacity:1!important}
 .pl.dark .sdr-card a{color:#14103A!important}
 /* Chiffres en dégradé (background-clip:text) : certains moteurs d'impression ne peignent pas
    le fond → texte transparent invisible (PDF Safari du 25/08). Couleur pleine à la place. */
 .kpi-v,.dl-kv,.dl-lab-s,.dl-r span,.rep-i b,.couv-s,.pj-v.goal-v,.pq-k b,.pq-ant,.ts b,.couv-acc strong{background:none!important;-webkit-text-fill-color:#5B4FE9!important;color:#5B4FE9!important}
 .ts{break-inside:avoid;page-break-inside:avoid}
 .pq-coach{background:#F7F5FE!important;border-color:#E4E0F5!important}
 ${''/* la carte app garde son violet à l'impression : c'est lui qui détoure les captures */}
 .pq-ch b,.pq-li b{color:#14103A!important} .pq-li span,.pq-k span{color:#5A5580!important}
 .pq-li{border-top-color:#E4E0F5!important} .pq-bande figure{border-color:#E4E0F5!important}
 .pq-coach,.pq-hab,.pq-bande figure{break-inside:avoid;page-break-inside:avoid}
 /* États FINAUX de tout ce que l'animation retient : sans eux, courbes, barres de projection,
    donuts et cascades restaient invisibles au-delà du point de défilement atteint. */
 .reveal{opacity:1!important;transform:none!important}
 .rule{transform:scaleX(1)!important}
 .crb-l{stroke-dashoffset:0!important}
 .crb-l2,.crb-a,.crb-pt{opacity:1!important}
 .pj-bar i{width:var(--w)!important}
 .ax-v{stroke-dashoffset:var(--o)!important}
 .casc-f{opacity:1!important}
 /* Filet : si une planche dépasse malgré le zoom, la coupe passe ENTRE les blocs, jamais dedans. */
 .kpi,.eq,.bl,.ax,.jl,.pb,.pj,.df,.av,.gmb-w,.tel-cadre,.crb,.mk-pod,.mk-ia,.mk-ads,.mk-ap,.sdr-card,.cit,.itw,.rcs,.dl-k,.portrait-bloc,.ill,.casc{break-inside:avoid;page-break-inside:avoid}
}
</style></head><body>
${(() => {
  // « Pourquoi Sofy » s'insère au RENDU, avant le CTA : les documents déjà générés la portent
  // aussi, et une correction du texte se déploie partout sans régénération.
  const plR = [...pl];
  const iCta = plR.findIndex(x => x && x.role === 'cta');
  if (iCta >= 0) plR.splice(iCta, 0, PLANCHE_POURQUOI); else plR.push(PLANCHE_POURQUOI);
  // Couverture v2 : les teasers se calculent une fois les planches en place (ils pointent vers
  // leurs numéros réels). Copie de l'objet : doc.planches ne doit jamais être muté.
  if (plR[0] && plR[0].role === 'couverture') {
    const c2 = couvertureV2(doc._mes || {}, plR, meta);
    if (c2) plR[0] = { ...plR[0], couv2: c2 };
  }
  return plR.map((p, i) => planche(p, i, plR.length, doc._mes || {}, doc._logo || null, sdr, images, doc._photo || null, instit)).join('');
})()}
${apercu ? `<div class="apercu">👁 Aperçu interne — cette visite n'est pas comptée dans les ouvertures du prospect.</div>` : ''}
<div class="tools"><button onclick="window.print()">⬇️ Télécharger en PDF</button></div>
<script>
// L'animation est une COUCHE, pas une condition d'affichage. Sans la classe « anim », la page
// est intégralement lisible : c'est ce qui garantit qu'un incident JavaScript ne peut plus
// produire un document blanc chez un prospect (incident du 20/08 : une expression régulière
// invalide tuait le script, et toutes les planches restaient à opacity 0).
(function(){
 var h=document.documentElement;
 h.classList.add('anim');
 // Trace de diagnostic : quand la couche tombe et pourquoi. Consultable dans la console par
 // window.__anim — c'est ce qui manquait pour comprendre l'incident des planches invisibles.
 window.__anim={pose:Date.now(),cause:null};
 var rendreVisible=function(quoi){return function(){
  if(!window.__anim.cause){window.__anim.cause=quoi;window.__anim.retire=Date.now()-window.__anim.pose;}
  h.classList.remove('anim');
 };};
 // Une erreur DE SCRIPT montre tout ; une image qui ne charge pas ne doit rien déclencher.
 window.addEventListener('error', function(e){ if(e && e.message) rendreVisible('erreur script : '+e.message)(); });
 setTimeout(rendreVisible('délai de sécurité'), 6000);
 if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)rendreVisible('mouvement réduit')();
})();
// Révélation au défilement + profondeur de lecture (le SDR voit jusqu'où le client est allé)
var jeton=${JSON.stringify(meta.jeton)},max=0,apercu=${apercu ? 'true' : 'false'};
document.querySelectorAll('.wrap').forEach(function(w){w.classList.add('reveal');});
// Compteurs : le chiffre monte jusqu'à sa valeur quand la planche entre dans l'écran
function anime(el){
 if(!document.documentElement.classList.contains('anim'))return; // sans animation, la valeur écrite reste
 var cible=parseFloat(el.dataset.n);if(isNaN(cible)||el.dataset.fait)return;el.dataset.fait='1';
 var u=el.querySelector('.kpi-u'),suf=u?u.outerHTML:'';
 var dec=Math.min(2,(String(el.dataset.n).split('.')[1]||'').length); // 2 décimales au plus
 var t0=null,dur=1100;
 function pas(ts){
  if(!t0)t0=ts;var k=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-k,3);
  el.innerHTML=(cible*e).toFixed(dec).replace('.',',')+suf;
  if(k<1)requestAnimationFrame(pas);
 }
 requestAnimationFrame(pas);
}
var io=new IntersectionObserver(function(es){es.forEach(function(e){
 if(!e.isIntersecting)return;
 e.target.classList.add('on');
 [].forEach.call(e.target.querySelectorAll('.reveal'),function(r,k){setTimeout(function(){r.classList.add('on');},60+k*70);});
 [].forEach.call(e.target.querySelectorAll('.kpi-v[data-n],.dl-kv[data-n],.ax-n b[data-n]'),function(v){anime(v);});
 var s=parseInt(e.target.closest('.pl').dataset.s||'0',10);
 if(s>max&&!apercu){max=s;clearTimeout(window._t);window._t=setTimeout(function(){
  try{navigator.sendBeacon('/api/p?j='+encodeURIComponent(jeton)+'&s='+max);}catch(_){}
 },900);}
});},{threshold:.28});
document.querySelectorAll('.wrap').forEach(function(w){io.observe(w);});
// Filet de sécurité : au bout de 3 s, tout ce qui n'a pas été révélé le devient. Une animation
// qui ne se déclenche pas ne doit jamais laisser une page blanche devant un prospect.
setTimeout(function(){
 document.querySelectorAll('.reveal:not(.on)').forEach(function(r){r.classList.add('on');});
 document.querySelectorAll('.kpi-v[data-n],.dl-kv[data-n],.ax-n b[data-n]').forEach(function(v){anime(v);});
},3000);
if(sdrCard=document.getElementById('sdr-card'))sdrCard.innerHTML=${JSON.stringify(contact)};
// ── PDF : une planche = une page, identique à l'écran ──
// Mesure chaque planche dans la mise en page d'impression (REGLES_IMPRESSION, la même feuille
// que @media print) et calcule son facteur de réduction --pz pour tenir dans une page A4.
// L'injection de style + mesure + retrait se font dans le même tour : rien n'est repeint.
var REGLES_IMPRESSION=${JSON.stringify(REGLES_IMPRESSION)};
var A4L=794,A4H=1123; // 210×297 mm en px CSS (96 dpi), marges @page à 0
function mesurerPlanches(){
 var st=document.createElement('style');st.textContent=REGLES_IMPRESSION;
 document.head.appendChild(st);
 document.querySelectorAll('.pl').forEach(function(p){
  // −16 px de marge : les arrondis du zoom suffisent à faire déborder une hauteur exacte,
  // et un débordement d'un pixel fabrique une page blanche entière.
  var z=Math.min(A4L/1000, (A4H-16)/Math.max(1,p.scrollHeight));
  // plancher à .42 : au-delà, mieux vaut couper entre les blocs que rendre le texte illisible
  p.style.setProperty('--pz', String(Math.max(.42, Math.floor(z*1000)/1000)));
 });
 st.remove();
}
function preparerImpression(){
 // 1. Tout ce que l'animation retient passe à l'état FINAL (l'état que montre l'écran après 3 s)
 document.querySelectorAll('.reveal:not(.on)').forEach(function(r){r.classList.add('on');});
 document.querySelectorAll('.kpi-v[data-n],.dl-kv[data-n],.ax-n b[data-n]').forEach(function(v){
  var n=parseFloat(v.dataset.n);if(isNaN(n))return; // même garde que anime() : parité écran/PDF
  var u=v.querySelector('.kpi-u'),dec=Math.min(2,(String(v.dataset.n).split('.')[1]||'').length);
  v.dataset.fait='1';v.innerHTML=n.toFixed(dec).replace('.',',')+(u?u.outerHTML:'');
 });
 // 2. Thème sombre → clair : le papier est blanc, la variante claire du design est complète
 document.querySelectorAll('.pl.dark').forEach(function(p){p.classList.remove('dark');p.classList.add('light');p.dataset.sombre='1';});
 mesurerPlanches();
}
function apresImpression(){
 document.querySelectorAll('.pl[data-sombre]').forEach(function(p){p.classList.add('dark');p.classList.remove('light');delete p.dataset.sombre;});
}
window.addEventListener('beforeprint',preparerImpression);
window.addEventListener('afterprint',apresImpression);
// Impression sans beforeprint (headless, vieux navigateurs) : pré-calcul des --pz au chargement,
// une fois les images arrivées (elles comptent dans la hauteur mesurée).
window.addEventListener('load',function(){setTimeout(mesurerPlanches,150);});
</script></body></html>`;
}

export default async function handler(req, res) {
  const jeton = String((req.query || {}).j || (req.query || {}).jeton || '').slice(0, 40);
  if (!jeton) return res.status(400).send('Lien incomplet.');

  // Une visite d'un utilisateur Sofy ne doit pas polluer la mesure : le compteur sert à savoir
  // si LE PROSPECT a lu. Deux verrous, parce qu'un seul laisse toujours passer un cas :
  //  · le cookie `sofy_staff`, posé par l'app sur le même domaine dès qu'on est connecté ;
  //  · `?apercu=1`, ajouté par le bouton « 👁 Voir » — couvre la navigation privée.
  const interne = /(?:^|;\s*)sofy_staff=1/.test(String(req.headers.cookie || ''))
    || String((req.query || {}).apercu || '') === '1';

  // Profondeur de lecture, envoyée par la page (sendBeacon) — jamais bloquant
  if (req.method === 'POST') {
    if (interne) return res.status(204).end();
    const s = parseInt((req.query || {}).s || '0', 10) || 0;
    try { await sql`UPDATE prez SET profondeur = GREATEST(COALESCE(profondeur,0), ${s}) WHERE jeton = ${jeton}`; } catch (_) {}
    return res.status(204).end();
  }

  // Page publique : un jeton inconnu — ou une table pas encore créée (aucune présentation
  // générée à ce jour, code PG 42P01) — doit donner un 404 lisible, jamais une erreur serveur.
  const introuvable = () => res.status(404)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .send('<!doctype html><meta charset="utf-8"><title>Analyse introuvable</title><meta name="robots" content="noindex">'
      + '<div style="font-family:system-ui,sans-serif;max-width:34em;margin:16vh auto;padding:0 6vw;color:#14103A">'
      + '<p style="font-size:22px;font-weight:800;letter-spacing:-.02em;margin:0 0 10px">Cette analyse n\'est plus disponible.</p>'
      + '<p style="color:#5A5580;line-height:1.6;margin:0">Le lien a peut-être expiré. Demandez-en un nouveau à votre interlocuteur Sofy — il le régénère en une minute.</p></div>');

  let row = null;
  try {
    const r = await sql`SELECT * FROM prez WHERE jeton = ${jeton}`;
    row = r[0] || null;
  } catch (e) {
    if (/relation .*prez.* does not exist|42P01/i.test(String(e && e.message))) return introuvable();
    return res.status(500).send('Analyse momentanément indisponible.');
  }
  try {
    if (!row) return introuvable();
    // Durée de vie : au-delà, le lien meurt (données périmées côté prospect, stockage côté Sofy).
    if (row.expire_le && new Date(row.expire_le).getTime() < Date.now()) return introuvable();
    const doc = row.contenu || {};

    // Coordonnées du commercial, lues au rendu pour rester à jour
    let sdr = null;
    try { const [s] = await sql`SELECT nom, email, ringover_numero, photo, poste, bio FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`; sdr = s || null; }
    catch (_) {
      // La colonne photo n'existe pas encore (aucun commercial ne l'a renseignée) : on continue.
      try { const [s] = await sql`SELECT nom, email, ringover_numero FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`; sdr = s || null; } catch (__) {}
    }

    // Un aperçu de lien (Slack, Gmail, WhatsApp) charge la page sans cookie et sans humain
    // derrière : il ne doit ni gonfler le compteur d'ouvertures, ni créer un « nouveau lecteur ».
    const ua = String(req.headers['user-agent'] || '');
    const robot = !ua || /bot|crawler|spider|preview|slack|discord|whatsapp|telegram|facebookexternalhit|twitterbot|linkedinbot|embedly|proxy|python-requests|curl|wget|headless/i.test(ua);
    const compte = !interne && !robot;
    const premiere = compte && !row.ouvertures;

    // ── Qui lit ? ── Le lien n'oblige personne à s'identifier. Mais si chaque destinataire a reçu
    // SON lien (/p/<jeton>?d=<n>), l'ouverture est attribuable sans rien demander au prospect.
    // C'est ce qui transforme « 6 ouvertures, 5 lecteurs » en « Lauriane a lu deux fois ».
    const dn = parseInt((req.query || {}).d, 10);
    const dests = Array.isArray(row.destinataires) ? row.destinataires : [];
    const dest = (Number.isInteger(dn) && dn >= 0 && dests[dn]) ? dests[dn] : null;
    if (compte && dest) {
      const maj = dests.slice();
      maj[dn] = { ...dest, ouvertures: (dest.ouvertures || 0) + 1,
        premiere_lecture: dest.premiere_lecture || new Date().toISOString(),
        derniere_lecture: new Date().toISOString() };
      try { await sql`UPDATE prez SET destinataires = ${JSON.stringify(maj)}::jsonb WHERE jeton = ${jeton}`; } catch (_) {}
    }
    const quiLit = dest ? (dest.nom || dest.email || dest.tel) : null;

    // Qui lit ? On ne peut pas NOMMER un lecteur sans l'obliger à s'identifier (ce qui tuerait le
    // taux d'ouverture). On peut en revanche les COMPTER : un identifiant aléatoire par appareil,
    // aucune IP, aucune donnée personnelle. Résultat exploitable : « 3 personnes, 7 ouvertures ».
    // Un 2ᵉ lecteur est le meilleur signal du document : le prospect l'a fait circuler en interne.
    const cookies = String(req.headers.cookie || '');
    const dejaVu = (cookies.match(/(?:^|;\s*)sl=([A-Za-z0-9]{6,24})/) || [])[1] || null;
    const lecteur = dejaVu || crypto.randomBytes(6).toString('hex');
    // Pas d'identifiant de lecteur posé sur le poste d'un employé : il ne doit jamais entrer
    // dans la liste des lecteurs, même s'il rouvre la page dix fois.
    if (!dejaVu && compte) res.setHeader('Set-Cookie', `sl=${lecteur}; Path=/p; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`);
    const connus = Array.isArray(row.lecteurs) ? row.lecteurs : [];
    const nouveauLecteur = compte && !connus.includes(lecteur);
    // Le compteur d'ouvertures EST le signal d'achat : s'il n'écrit pas, le SDR ne saura jamais
    // que son prospect a lu. On ne casse évidemment pas la page pour autant (le prospect est en
    // train de la lire), mais la panne est tracée, et l'alerte Slack part quand même — elle est
    // calculée avant et ne dépend pas de cette écriture.
    if (compte) try {
      await sql`UPDATE prez SET ouvertures = COALESCE(ouvertures,0) + 1, derniere_ouverture = NOW(),
        premiere_ouverture = COALESCE(premiere_ouverture, NOW()),
        lecteurs = CASE WHEN COALESCE(lecteurs,'[]'::jsonb) @> ${JSON.stringify([lecteur])}::jsonb
                        THEN lecteurs ELSE COALESCE(lecteurs,'[]'::jsonb) || ${JSON.stringify([lecteur])}::jsonb END
        WHERE jeton = ${jeton}`;
    } catch (e) {
      console.error('[ouverture NON comptée]', 'jeton=' + jeton, String((e && e.message) || e).slice(0, 160));
    }

    // Première ouverture = signal d'achat. C'est plus fort qu'un email ouvert : le prospect a
    // cliqué, il lit une analyse de SA situation. Le SDR doit le savoir tout de suite.
    //
    // MAIS pas dix fois. Le 20/08, Didier a reçu une rafale d'alertes pour les ouvertures
    // successives d'un même lien : un aperçu de lien (Slack, Gmail, WhatsApp) arrive sans
    // cookie, compte donc comme un « nouveau lecteur », et déclenche une alerte de plus.
    // Trois verrous, du moins coûteux au plus sûr :
    //   1. les robots et générateurs d'aperçu ne comptent pas comme des lecteurs ;
    //   2. au-delà du 3ᵉ lecteur, plus d'alerte — le signal est acquis, le répéter lasse ;
    //   3. une seule alerte « nouveau lecteur » toutes les 4 h par document.
    let alerteRecente = false;
    if (!premiere) {
      try {
        const [a] = await sql`SELECT (derniere_alerte > NOW() - INTERVAL '4 hours') AS recente FROM prez WHERE jeton = ${jeton}`;
        alerteRecente = !!(a && a.recente);
      } catch (_) {
        // Colonne absente (documents créés avant cette version) : on la crée à la volée, sans
        // toucher au SCHEMA_VERSION — cf. incident « analyse » du 03/08.
        try { await sql`ALTER TABLE prez ADD COLUMN IF NOT EXISTS derniere_alerte TIMESTAMPTZ`; } catch (__) {}
      }
    }
    const alerter = !robot && (premiere
      || (nouveauLecteur && connus.length >= 1 && connus.length < 3 && !alerteRecente));
    if (alerter) {
      try { await sql`UPDATE prez SET derniere_alerte = NOW() WHERE jeton = ${jeton}`; } catch (_) {}
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook) {
        try {
          await fetch(hook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: premiere
                ? `👀 *${row.client || 'Un prospect'}* : ${quiLit ? `*${quiLit}* vient d'ouvrir` : 'quelqu\'un vient d\'ouvrir'} l'analyse Sofy (${row.module || ''}).\n` +
                  `Préparée par ${row.sdr || '?'}${(!quiLit && row.destinataire) ? ` · envoyée à ${row.destinataire}` : ''} · c'est le moment de rappeler.`
                : `🔥 *${row.client || 'Un prospect'}* : ${quiLit ? `*${quiLit}* lit l'analyse à son tour` : `une ${connus.length + 1}ᵉ personne lit l'analyse`}${(!quiLit && row.destinataire) ? ` (lien envoyé à ${row.destinataire})` : ''}.\n` +
                  `Le document circule en interne — ${row.sdr || '?'}, appelle maintenant.`,
              unfurl_links: false
            })
          });
        } catch (_) {}
      }
      // Trace dans le bloc-notes de la fiche
      if (row.cle_fiche) {
        try {
          await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
            VALUES (${String(row.cle_fiche).toLowerCase()}, 'prez', 'note',
              ${'👀 Analyse Sofy ouverte' + (quiLit ? ' par ' + quiLit : ' par le prospect')},
              ${'Présentation ' + (row.module || '') + ' — ' + (premiere ? 'première ouverture' : 'nouveau lecteur')}, 'système', NOW())`;
        } catch (_) {}
      }
    }

    // Les images des visuels posés : une seule requête, et seulement celles réellement utilisées.
    let images = {};
    try {
      const ids = (doc.planches || []).map(p => p.visuel_id).filter(Boolean);
      if (ids.length) images = await imagesDe(ids);
    } catch (_) {}

    // La trame institutionnelle : photo d'équipe et logos clients pris dans la bibliothèque.
    // Elle est identique pour toutes les analyses, donc lue ici et jamais rédigée par l'IA.
    let instit = null;
    try { instit = await visuelsInstit(); } catch (_) {}

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(page(doc, { jeton, cree_le: row.created_at, expire_le: row.expire_le }, sdr, interne, images, instit));
  } catch (e) {
    return res.status(500).send('Analyse momentanément indisponible.');
  }
}
