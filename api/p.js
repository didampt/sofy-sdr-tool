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

function planche(p, i, total) {
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
    const max = Number(x.max) || Math.max(Number(x.cible) || 0, Number(x.actuel) || 0) * 1.15 || 1;
    const pa = Math.max(2, Math.min(100, Math.round((Number(x.actuel) || 0) / max * 100)));
    const pc = Math.max(2, Math.min(100, Math.round((Number(x.cible) || 0) / max * 100)));
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
  const cit = p.citation && p.citation.texte ? `
    <blockquote class="cit">${md(p.citation.texte)}
      ${p.citation.meta ? `<cite>${esc(p.citation.meta)}</cite>` : ''}</blockquote>` : '';
  return `<section class="pl ${sombre ? 'dark' : 'light'}" data-s="${i}">
    <div class="wrap">
      <header class="pl-h">
        <span class="logo">sofy</span>
        <span class="pag">${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span>
      </header>
      ${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}
      <h2 class="pl-t">${md(p.titre)}</h2>
      <div class="rule"></div>
      ${p.texte ? `<p class="pl-x">${md(p.texte)}</p>` : ''}
      ${chiffres ? `<div class="kpis">${chiffres}</div>` : ''}
      ${problemes ? `<div class="pbs">${problemes}</div>` : ''}
      ${proj ? `<div class="pjs">${proj}</div>` : ''}
      ${points ? `<div class="pts">${points}</div>` : ''}
      ${cit}
      ${p.role === 'cta' ? `<div class="cta-zone">
        <a class="btn-demo" href="${esc(LIEN_DEMO())}" target="_blank" rel="noopener">📅 ${esc(p.cta || 'Réserver 15 minutes')}</a>
        <div class="sdr-card" id="sdr-card"></div>
      </div>` : ''}
      <footer class="pl-f"><span>sofy.fr</span><span>${esc(p.eyebrow || '')}</span></footer>
    </div>
  </section>`;
}

function page(doc, meta, sdr) {
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
.pj-bar i{display:block;height:100%;width:0;border-radius:8px;transition:width 1.15s cubic-bezier(.22,.68,.24,1)}
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
.reveal{opacity:0;transform:translateY(20px);transition:opacity .75s ease var(--d,0ms),transform .75s cubic-bezier(.22,.68,.24,1) var(--d,0ms)}
.reveal.on{opacity:1;transform:none}
.pl-t .w{display:inline-block;opacity:0;transform:translateY(14px);transition:opacity .5s ease,transform .5s ease}
.on .pl-t .w,.pl-t.on .w{opacity:1;transform:none}
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
${pl.map((p, i) => planche(p, i, pl.length)).join('')}
<div class="tools"><button onclick="window.print()">⬇️ Télécharger en PDF</button></div>
<script>
// Révélation au défilement + profondeur de lecture (le SDR voit jusqu'où le client est allé)
var jeton=${JSON.stringify(meta.jeton)},max=0;
document.querySelectorAll('.wrap').forEach(function(w){w.classList.add('reveal');});
// Titres révélés mot à mot : donne du rythme sans tomber dans l'effet gadget
document.querySelectorAll('.pl-t').forEach(function(t){
 t.innerHTML=t.innerHTML.replace(/(<strong>)?([^<\s]+)(<\/strong>)?(\s|$)/g,function(m){return '<span class="w">'+m+'</span>';});
 [].forEach.call(t.querySelectorAll('.w'),function(w,k){w.style.transitionDelay=(90+k*45)+'ms';});
});
// Compteurs : le chiffre monte jusqu'à sa valeur quand la planche entre dans l'écran
function anime(el){
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
 [].forEach.call(e.target.querySelectorAll('.kpi-v[data-n]'),function(v){anime(v);});
 var s=parseInt(e.target.closest('.pl').dataset.s||'0',10);
 if(s>max){max=s;clearTimeout(window._t);window._t=setTimeout(function(){
  try{navigator.sendBeacon('/api/p?j='+encodeURIComponent(jeton)+'&s='+max);}catch(_){}
 },900);}
});},{threshold:.28});
document.querySelectorAll('.wrap').forEach(function(w){io.observe(w);});
if(sdrCard=document.getElementById('sdr-card'))sdrCard.innerHTML=${JSON.stringify(contact)};
</script></body></html>`;
}

export default async function handler(req, res) {
  const jeton = String((req.query || {}).j || (req.query || {}).jeton || '').slice(0, 40);
  if (!jeton) return res.status(400).send('Lien incomplet.');

  // Profondeur de lecture, envoyée par la page (sendBeacon) — jamais bloquant
  if (req.method === 'POST') {
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
    try { const [s] = await sql`SELECT nom, email, ringover_numero FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`; sdr = s || null; } catch (_) {}

    const premiere = !row.ouvertures;

    // Qui lit ? On ne peut pas NOMMER un lecteur sans l'obliger à s'identifier (ce qui tuerait le
    // taux d'ouverture). On peut en revanche les COMPTER : un identifiant aléatoire par appareil,
    // aucune IP, aucune donnée personnelle. Résultat exploitable : « 3 personnes, 7 ouvertures ».
    // Un 2ᵉ lecteur est le meilleur signal du document : le prospect l'a fait circuler en interne.
    const cookies = String(req.headers.cookie || '');
    const dejaVu = (cookies.match(/(?:^|;\s*)sl=([A-Za-z0-9]{6,24})/) || [])[1] || null;
    const lecteur = dejaVu || crypto.randomBytes(6).toString('hex');
    if (!dejaVu) res.setHeader('Set-Cookie', `sl=${lecteur}; Path=/p; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`);
    const connus = Array.isArray(row.lecteurs) ? row.lecteurs : [];
    const nouveauLecteur = !connus.includes(lecteur);
    try {
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
    return res.status(200).send(page(doc, { jeton }, sdr));
  } catch (e) {
    return res.status(500).send('Analyse momentanément indisponible.');
  }
}
