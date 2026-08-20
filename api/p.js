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

function planche(p, i, total, mes, logo, sdr) {
  const sombre = i % 2 === 1;
  const chiffres = (p.chiffres || []).map(c => `
    <div class="kpi">
      <div class="kpi-v" data-n="${esc(String(c.valeur).replace(',', '.'))}">${esc(c.valeur)}${c.unite ? `<span class="kpi-u">${esc(c.unite)}</span>` : ''}</div>
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
  const duel = (p.probleme && p.solution) ? `
    <div class="duel">
      <div class="dl-p reveal">
        <div class="dl-lab">Ce que nous avons mesuré</div>
        <div class="dl-c">${md(p.probleme.constat)}</div>
        ${p.probleme.cout ? `<div class="dl-cout"><span>Ce que ça coûte</span>${md(p.probleme.cout)}</div>` : ''}
      </div>
      <div class="dl-fl reveal" style="--d:120ms" aria-hidden="true"><span>Sofy</span></div>
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

  // Trajectoire : une courbe qui se dessine, pas deux barres. C'est ce que le prospect regarde
  // pour se projeter — d'où le tracé animé et les valeurs posées sur chaque point.
  let courbe = '';
  if (p.courbe && Array.isArray(p.courbe.points) && p.courbe.points.length > 1
      && p.courbe.points.filter(x => x && num(x.valeur) != null).length > 1) {
    const pts = p.courbe.points.filter(x => x && num(x.valeur) != null);
    const vals = pts.map(x => num(x.valeur));
    const haut = num(p.courbe.max) || Math.max(...vals) * 1.18;
    const bas = Math.min(...vals) * 0.82;
    const W = 760, H = 260, PX = 54, PY = 34;
    const xy = pts.map((x, k) => [
      PX + k * ((W - PX * 2) / (pts.length - 1)),
      H - PY - ((num(x.valeur) - bas) / (haut - bas || 1)) * (H - PY * 2)
    ]);
    const d = xy.map((c, k) => (k ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
    const aire = d + ` L${xy[xy.length - 1][0].toFixed(1)} ${H - PY} L${xy[0][0].toFixed(1)} ${H - PY} Z`;
    const fmt = v => String(v).replace('.', ',');
    courbe = `<div class="crb reveal">
      <div class="crb-h"><span class="crb-i">${md(p.courbe.indicateur || '')}</span></div>
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
        <path d="${d}" fill="none" stroke="url(#gl)" stroke-width="3.5" stroke-linecap="round" class="crb-l"/>
        ${xy.map((c, k) => `<g class="crb-pt" style="--d:${700 + k * 190}ms">
          <circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${k === xy.length - 1 ? 7 : 5}"
            fill="${k === xy.length - 1 ? '#F0428A' : '#5B4FE9'}" stroke="#fff" stroke-width="2.5"/>
          <text x="${c[0].toFixed(1)}" y="${(c[1] - 16).toFixed(1)}" class="crb-v">${fmt(pts[k].valeur)}${esc(p.courbe.unite || '')}</text>
          <text x="${c[0].toFixed(1)}" y="${H - PY + 22}" class="crb-x">${esc(pts[k].quand || '')}</text>
        </g>`).join('')}
      </svg>
      ${p.courbe.appui ? `<div class="crb-s2">${md(p.courbe.appui)}</div>` : ''}
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

  // Les défauts relevés sur la fiche : liste sèche, chaque ligne est un fait opposable.
  const defauts = (p.defauts || []).length ? `<div class="dfs">
      ${(p.defauts || []).map((x, k) => `<div class="df reveal" style="--d:${k * 95}ms">
        <span class="df-x">✕</span><span>${md(x)}</span></div>`).join('')}
    </div>` : '';

  // La maquette RCS : le message que le prospect pourrait envoyer demain, écrit pour son métier.
  const r = p.maquette_rcs || {};
  const rcs = (r.titre || r.texte) ? `<div class="rcs reveal">
      <div class="tel">
        <div class="tel-n"></div>
        <div class="tel-e">
          <div class="tel-t">Messages</div>
          <div class="bul">
            <div class="bul-e">${esc(r.expediteur || mes.nom || '')} <span>vérifié ✓</span></div>
            ${r.titre ? `<div class="bul-ti">${md(r.titre)}</div>` : ''}
            ${r.texte ? `<div class="bul-x">${md(r.texte)}</div>` : ''}
            ${r.bouton ? `<div class="bul-b">${esc(r.bouton)}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="rcs-l">
        <div class="rcs-t">Ce que vos clients recevraient</div>
        <div class="rcs-x">Le RCS affiche le nom vérifié de votre enseigne, son logo et un bouton cliquable — là où un SMS classique n'affiche qu'un numéro court anonyme. Bascule automatique en SMS si le téléphone ne prend pas le RCS : aucun message perdu.</div>
      </div>
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
          <div class="ax-c">
            ${(a.criteres || []).map(x => `<div class="ax-l ${esc(x.etat)}">
              <span class="ax-p"></span>
              <span><b>${md(x.libelle)}</b>${x.detail ? ` — ${md(x.detail)}` : ''}</span>
            </div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
    ${sc.site_analyse === false ? `<div class="ax-w reveal">Le site n'a pas encore été analysé : les axes Relation client et Communication mobile sont donc partiels. L'audit complet se fait au premier rendez-vous.</div>` : ''}` : '';

  const cit = p.citation && p.citation.texte ? `
    <blockquote class="cit">${md(p.citation.texte)}
      ${p.citation.meta ? `<cite>${esc(p.citation.meta)}</cite>` : ''}</blockquote>` : '';
  const couv = p.role === 'couverture';
  return `<section class="pl ${sombre ? 'dark' : 'light'}${couv ? ' pl-couv' : ''}" data-s="${i}">
    <div class="wrap${couv && sdr && sdr.photo ? ' wrap-couv' : ''}">
      <header class="pl-h">
        <span class="logo">sofy</span>
        <span class="pag">${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span>
      </header>
      ${p.role === 'couverture' ? `<div class="couv-h">
        ${logo ? `<img class="logo-p" src="${esc(logo)}" alt="">` : ''}
        <div class="couv-x"><span class="couv-s">Analyse Sofy</span><span class="couv-p">préparée pour ${esc(p.titre || '')}</span></div>
      </div>` : ''}
      ${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}
      <h2 class="pl-t">${md(p.titre)}</h2>
      <div class="rule"></div>
      ${p.texte ? `<p class="pl-x">${md(p.texte)}</p>` : ''}
      ${bilan}
      ${ficheG}
      ${chiffres ? `<div class="kpis">${chiffres}</div>` : ''}
      ${avisReel}
      ${defauts}
      ${problemes ? `<div class="pbs">${problemes}</div>` : ''}
      ${duel}
      ${rcs}
      ${courbe}
      ${jalons ? `<div class="jls">${jalons}</div>` : ''}
      ${proj ? `<div class="pjs">${proj}</div>` : ''}
      ${points ? `<div class="pts">${points}</div>` : ''}
      ${cit}
      ${couv && sdr && sdr.photo ? `<div class="portrait reveal"><img src="${esc(sdr.photo)}" alt="${esc(sdr.nom || '')}"><span class="portrait-l">${esc(sdr.nom || '')}<i>Sofy</i></span></div>` : ''}
      ${p.role === 'couverture' && sdr && (sdr.photo || sdr.nom) ? `<div class="ae reveal">
        ${sdr.photo ? `<img class="ae-p" src="${esc(sdr.photo)}" alt="">`
          : `<span class="ae-i">${esc(String(sdr.nom || '?').trim().charAt(0).toUpperCase())}</span>`}
        <div><div class="ae-n">${esc(sdr.nom || '')}</div>
          <div class="ae-r">Votre interlocuteur chez Sofy</div>
          ${sdr.email ? `<a class="ae-c" href="mailto:${esc(sdr.email)}">${esc(sdr.email)}</a>` : ''}
          ${sdr.ringover_numero ? `<a class="ae-c" href="tel:${esc(String(sdr.ringover_numero).replace(/\s/g, ''))}">${esc(sdr.ringover_numero)}</a>` : ''}
        </div>
      </div>` : ''}
      ${p.role === 'cta' ? `<div class="cta-zone">
        <a class="btn-demo" href="${esc(LIEN_DEMO())}" target="_blank" rel="noopener">📅 ${esc(p.cta || 'Réserver 15 minutes')}</a>
        <div class="sdr-card" id="sdr-card"></div>
      </div>` : ''}
      <footer class="pl-f"><span>sofy.fr</span><span>${esc(p.eyebrow || '')}</span></footer>
    </div>
  </section>`;
}

function page(doc, meta, sdr, apercu) {
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
.cta-zone{display:flex;gap:22px;flex-wrap:wrap;align-items:center;margin-top:38px}
.btn-demo{display:inline-block;padding:17px 30px;border-radius:13px;background:var(--grad);color:#fff;
 text-decoration:none;font-weight:750;font-size:17px;box-shadow:0 12px 32px rgba(91,79,233,.38)}
.sdr-card{font-size:14.5px;line-height:1.65}
.sdr-n{font-weight:800;font-size:17px}
.sdr-r{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--r);margin-bottom:6px}
.sdr-card a{display:block;color:#fff;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.3);width:fit-content}
.sdr-x{margin-top:8px;color:var(--ink-ds);font-size:13px}
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
.dfs{display:flex;flex-direction:column;gap:10px;margin-top:30px;max-width:76ch}
.df{display:flex;gap:12px;align-items:flex-start;padding:14px 17px;border-radius:11px;font-size:14.5px;line-height:1.5}
.pl.light .df{background:#FFF4F6;border:1px solid #F7C9D8}
.pl.dark .df{background:rgba(240,66,138,.1);border:1px solid rgba(240,66,138,.28)}
.df-x{flex:none;width:21px;height:21px;border-radius:50%;background:var(--r);color:#fff;font-size:11px;
 font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px}
.rcs{display:grid;gap:26px;margin-top:34px;align-items:center;grid-template-columns:1fr}
@media(min-width:820px){.rcs{grid-template-columns:262px 1fr}}
.tel{width:262px;max-width:100%;border-radius:34px;padding:11px;background:#14103A;
 box-shadow:0 10px 26px rgba(0,0,0,.24),0 34px 70px rgba(20,16,58,.26);position:relative}
.tel-n{position:absolute;top:19px;left:50%;transform:translateX(-50%);width:62px;height:5px;border-radius:3px;background:rgba(255,255,255,.22)}
.tel-e{background:#F2F1F8;border-radius:26px;padding:34px 13px 20px;min-height:330px}
.tel-t{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8B84B0;text-align:center;margin-bottom:13px}
.bul{background:#fff;border-radius:17px;padding:14px 15px;box-shadow:0 2px 8px rgba(20,16,58,.11);color:#14103A}
.bul-e{font-size:11.5px;font-weight:700;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.bul-e span{font-size:10px;font-weight:600;color:#0F6E56;background:#EAF6F1;border-radius:4px;padding:1px 5px}
.bul-ti{font-size:14.5px;font-weight:750;line-height:1.3;margin-top:9px}
.bul-x{font-size:13px;line-height:1.5;margin-top:6px;color:#5A5580}
.bul-b{margin-top:13px;text-align:center;font-size:13px;font-weight:700;color:#fff;background:var(--grad);
 border-radius:10px;padding:10px 12px}
.rcs-t{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:9px}
.pl.light .rcs-t{color:var(--v)} .pl.dark .rcs-t{color:var(--r)}
.rcs-x{font-size:14.5px;line-height:1.6;max-width:52ch}
.pl.light .rcs-x{color:var(--ink-s)} .pl.dark .rcs-x{color:var(--ink-ds)}
@media print{.tel{box-shadow:none}.gmb-w{box-shadow:none}}
.wrap-couv{display:grid;gap:clamp(24px,4vw,52px);align-items:center;grid-template-columns:1fr}
@media(min-width:900px){.wrap-couv{grid-template-columns:1.25fr .75fr}
 .wrap-couv .pl-h{grid-column:1/-1}
 .wrap-couv .pl-f{grid-column:1/-1}
 .wrap-couv .portrait{grid-row:2/span 6;grid-column:2}}
.portrait{position:relative;border-radius:20px;overflow:hidden;align-self:center;justify-self:center;
 width:100%;max-width:330px;aspect-ratio:4/5}
.portrait img{width:100%;height:100%;object-fit:cover;display:block}
.portrait::after{content:'';position:absolute;inset:0;
 background:linear-gradient(180deg,rgba(91,79,233,0) 45%,rgba(15,11,41,.72) 100%)}
.portrait-l{position:absolute;left:16px;right:16px;bottom:14px;z-index:1;color:#fff;
 font-size:15px;font-weight:750;letter-spacing:-.01em;line-height:1.2}
.portrait-l i{display:block;font-style:normal;font-size:11px;font-weight:700;letter-spacing:.14em;
 text-transform:uppercase;opacity:.8;margin-top:3px}
@media print{.portrait{max-width:210px}.portrait::after{display:none}}
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
.ax-w{font-size:12.5px;line-height:1.5;margin-top:16px;padding:12px 15px;border-radius:10px}
.pl.light .ax-w{background:#FEF6E7;border:1px solid #E9C88B;color:#7A4E12}
.pl.dark .ax-w{background:rgba(224,162,83,.12);border:1px solid rgba(224,162,83,.34);color:#E9C88B}
@media print{.ax,.bl-k,.ae{box-shadow:none}}
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
.dl-fl{display:none}
@media(min-width:900px){.dl-fl{display:flex;align-items:center;justify-content:center;position:relative}}
.dl-fl::before{content:'';position:absolute;left:6px;right:6px;height:2px;background:var(--grad);opacity:.42}
.dl-fl span{position:relative;z-index:1;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
 padding:4px 9px;border-radius:20px;background:var(--grad);color:#fff}
.dl-k{display:flex;align-items:center;gap:18px;margin-top:20px;padding:18px 22px;border-radius:14px;flex-wrap:wrap}
.pl.light .dl-k{background:#F4F2FD;border:1px solid var(--line)}
.pl.dark .dl-k{background:rgba(255,255,255,.055);border:1px solid var(--line-d)}
.dl-kv{font-size:clamp(34px,5vw,54px);font-weight:800;letter-spacing:-.035em;line-height:1;
 background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.dl-kl{font-size:14.5px;line-height:1.45;max-width:46ch}
.dl-kl span{display:block;font-size:11.5px;margin-top:4px}
.pl.light .dl-kl span{color:#9990C4} .pl.dark .dl-kl span{color:rgba(255,255,255,.45)}
.crb{margin-top:34px;max-width:820px}
.crb-i{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.pl.light .crb-i{color:var(--v)} .pl.dark .crb-i{color:var(--r)}
.crb-s{width:100%;height:auto;margin-top:8px;overflow:visible}
.crb-g{stroke:var(--line);stroke-width:1}
.pl.dark .crb-g{stroke:rgba(255,255,255,.11)}
.anim .crb-l{stroke-dasharray:1400;stroke-dashoffset:1400;transition:stroke-dashoffset 1.8s cubic-bezier(.4,.05,.2,1) .25s}
.reveal.on .crb-l{stroke-dashoffset:0}
.anim .crb-a{opacity:0;transition:opacity .9s ease 1.1s}
.reveal.on .crb-a{opacity:1}
.anim .crb-pt{opacity:0;transition:opacity .45s ease var(--d)}
.reveal.on .crb-pt{opacity:1}
.crb-v{font-size:16px;font-weight:800;text-anchor:middle;font-variant-numeric:tabular-nums;fill:var(--ink)}
.pl.dark .crb-v{fill:var(--ink-d)}
.crb-x{font-size:12px;text-anchor:middle;fill:#9990C4}
.pl.dark .crb-x{fill:rgba(255,255,255,.45)}
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
.apercu{position:fixed;left:14px;bottom:14px;z-index:50;background:#14103A;color:#fff;font-size:12.5px;
 padding:8px 13px;border-radius:9px;max-width:min(360px,86vw);line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.28)}
@media print{.apercu{display:none}}
.anim .reveal{opacity:0;transform:translateY(20px);transition:opacity .75s ease var(--d,0ms),transform .75s cubic-bezier(.22,.68,.24,1) var(--d,0ms)}
.anim .reveal.on,.reveal.on{opacity:1;transform:none}
.rule{transform:scaleX(0);transform-origin:left;transition:transform .8s cubic-bezier(.22,.68,.24,1) .15s}
.on .rule{transform:scaleX(1)}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}}
@media print{
 .tools{display:none} html,body{background:#fff}
 .pl{min-height:auto;page-break-after:always;padding:24px 0;background:#fff!important;color:#14103A!important}
 .pl.dark .pl-t,.pl.dark .kpi-l,.pl.dark .pt-x,.pl.dark .pl-x{color:#14103A!important}
 .pl.dark .kpi,.pl.dark .cit{background:#F7F5FE!important;border-color:#E4E0F5!important}
 .pl.dark .logo{color:#5B4FE9!important} .pl.dark .sdr-card a{color:#14103A!important}
 .reveal{opacity:1!important;transform:none!important}
}
</style></head><body>
${pl.map((p, i) => planche(p, i, pl.length, doc._mes || {}, doc._logo || null, sdr)).join('')}
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
 var u=el.querySelector('.kpi-u'),suf=u?u.outerHTML:'',dec=(String(el.dataset.n).split('.')[1]||'').length;
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
    try { const [s] = await sql`SELECT nom, email, ringover_numero, photo FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`; sdr = s || null; }
    catch (_) {
      // La colonne photo n'existe pas encore (aucun commercial ne l'a renseignée) : on continue.
      try { const [s] = await sql`SELECT nom, email, ringover_numero FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`; sdr = s || null; } catch (__) {}
    }

    const premiere = !interne && !row.ouvertures;

    // Qui lit ? On ne peut pas NOMMER un lecteur sans l'obliger à s'identifier (ce qui tuerait le
    // taux d'ouverture). On peut en revanche les COMPTER : un identifiant aléatoire par appareil,
    // aucune IP, aucune donnée personnelle. Résultat exploitable : « 3 personnes, 7 ouvertures ».
    // Un 2ᵉ lecteur est le meilleur signal du document : le prospect l'a fait circuler en interne.
    const cookies = String(req.headers.cookie || '');
    const dejaVu = (cookies.match(/(?:^|;\s*)sl=([A-Za-z0-9]{6,24})/) || [])[1] || null;
    const lecteur = dejaVu || crypto.randomBytes(6).toString('hex');
    // Pas d'identifiant de lecteur posé sur le poste d'un employé : il ne doit jamais entrer
    // dans la liste des lecteurs, même s'il rouvre la page dix fois.
    if (!dejaVu && !interne) res.setHeader('Set-Cookie', `sl=${lecteur}; Path=/p; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`);
    const connus = Array.isArray(row.lecteurs) ? row.lecteurs : [];
    const nouveauLecteur = !interne && !connus.includes(lecteur);
    if (!interne) try {
      await sql`UPDATE prez SET ouvertures = COALESCE(ouvertures,0) + 1, derniere_ouverture = NOW(),
        premiere_ouverture = COALESCE(premiere_ouverture, NOW()),
        lecteurs = CASE WHEN COALESCE(lecteurs,'[]'::jsonb) @> ${JSON.stringify([lecteur])}::jsonb
                        THEN lecteurs ELSE COALESCE(lecteurs,'[]'::jsonb) || ${JSON.stringify([lecteur])}::jsonb END
        WHERE jeton = ${jeton}`;
    } catch (_) {}

    // Première ouverture = signal d'achat. C'est plus fort qu'un email ouvert : le prospect a
    // cliqué, il lit une analyse de SA situation. Le SDR doit le savoir tout de suite.
    if (premiere || (nouveauLecteur && connus.length)) {
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook) {
        try {
          await fetch(hook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: premiere
                ? `👀 *${row.client || 'Un prospect'}* vient d'ouvrir son analyse Sofy (${row.module || ''}).\n` +
                  `Préparée par ${row.sdr || '?'}${row.destinataire ? ` · envoyée à ${row.destinataire}` : ''} · c'est le moment de rappeler.`
                : `🔥 *${row.client || 'Un prospect'}* : une ${connus.length + 1}ᵉ personne lit l'analyse${row.destinataire ? ` (lien envoyé à ${row.destinataire})` : ''}.\n` +
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
            VALUES (${String(row.cle_fiche).toLowerCase()}, 'prez', 'note', '👀 Analyse Sofy ouverte par le prospect',
              ${'Présentation ' + (row.module || '') + ' — première ouverture'}, 'système', NOW())`;
        } catch (_) {}
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(page(doc, { jeton }, sdr, interne));
  } catch (e) {
    return res.status(500).send('Analyse momentanément indisponible.');
  }
}
