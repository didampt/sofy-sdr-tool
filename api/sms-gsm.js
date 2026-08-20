// /api/sms-gsm.js — Assainir un texte pour l'alphabet SMS, et compter les vrais segments.
//
// Remarque de Didier (20/08) : « j'ai vu que tu as ajouté une étoile, cela ne passe pas en SMS ».
// Exact, et c'est plus coûteux qu'il n'y paraît : UN seul caractère hors GSM 03.38 fait basculer
// le message entier en UCS-2, donc 70 caractères par segment au lieu de 160. Un SMS de repli de
// 158 caractères contenant « 1,7★ » part en 3 segments facturés au lieu d'un seul.
//
// Ce module ne sert pas qu'au RCS : tout message sortant (repli SMS, alerte) doit passer par
// gsmifier() avant d'être compté ou envoyé.

// Alphabet GSM 03.38 de base — chaque caractère compte 1.
const GSM_BASE = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension : présents en GSM mais comptés DOUBLE (préfixe d'échappement).
const GSM_EXT = '^{}\\[~]|€';

const BASE = new Set(GSM_BASE.split(''));
const EXT = new Set(GSM_EXT.split(''));

// Remplacements : ce qu'on écrit naturellement en français ou en marketing → équivalent GSM.
// L'étoile devient « /5 » quand elle suit une note, sinon « etoiles » : une note « 1,7★ » doit
// rester lisible, pas devenir « 1,7 ».
const REMPLACEMENTS = [
  [/(\d(?:[.,]\d)?)\s*★+/g, '$1/5'],   // 1,7★ → 1,7/5
  [/★/g, ' etoiles'],
  [/[’‘‛]/g, "'"],
  [/«\s*/g, '"'], [/\s*»/g, '"'], [/[“”„]/g, '"'],
  [/[–—―]/g, '-'], [/…/g, '...'], [/•/g, '-'], [/·/g, '-'],
  [/[    ]/g, ' '],  // espaces insécables et fines
  [/[≥≈≤]/g, ''], [/→/g, '->'], [/↳/g, '-'],
  [/œ/g, 'oe'], [/Œ/g, 'OE'], [/æ/g, 'ae'], [/Æ/g, 'AE'],
  [/[™®©]/g, ''], [/²/g, '2'], [/½/g, '1/2'],
  [/​|﻿/g, '']
];

// Les accents non-GSM (â, ê, î, ô, û, ç majuscule…) : on les déshabille plutôt que de basculer
// tout le message en Unicode pour une seule lettre.
const PLIAGE = { 'â': 'a', 'ä': 'ä', 'ê': 'e', 'ë': 'e', 'î': 'i', 'ï': 'i', 'ô': 'o', 'û': 'u', 'ü': 'ü', 'ÿ': 'y', 'Ê': 'E', 'Î': 'I', 'Ô': 'O', 'Û': 'U', 'Â': 'A', 'À': 'A', 'É': 'É', 'È': 'E', 'Ù': 'U' };

export function gsmifier(txt) {
  let s = String(txt == null ? '' : txt);
  for (const [re, par] of REMPLACEMENTS) s = s.replace(re, par);
  // Emojis et symboles restants : retirés (un emoji dans un SMS coûte deux caractères UCS-2
  // et fait basculer le segment entier).
  s = s.split('').map(c => {
    if (BASE.has(c) || EXT.has(c)) return c;
    if (PLIAGE[c] !== undefined) return PLIAGE[c];
    const d = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (d && [...d].every(x => BASE.has(x) || EXT.has(x))) return d;
    return '';
  }).join('');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// Longueur facturée : les caractères d'extension comptent double.
export function longueurGsm(txt) {
  let n = 0;
  for (const c of String(txt || '')) n += EXT.has(c) ? 2 : 1;
  return n;
}

export function estGsm(txt) {
  return [...String(txt || '')].every(c => BASE.has(c) || EXT.has(c));
}

// Segments réellement facturés par l'opérateur.
export function segments(txt) {
  const s = String(txt || '');
  if (estGsm(s)) {
    const n = longueurGsm(s);
    return n <= 160 ? 1 : Math.ceil(n / 153); // concaténation : 153 utiles par segment
  }
  const n = [...s].length;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

// Diagnostic complet, à afficher au SDR avant l'envoi.
export function analyserSms(txt) {
  const brut = String(txt || '');
  const propre = gsmifier(brut);
  const perdus = [...new Set([...brut].filter(c => !BASE.has(c) && !EXT.has(c) && !/\s/.test(c)))];
  return {
    texte: propre,
    caracteres: longueurGsm(propre),
    segments: segments(propre),
    alphabet: estGsm(propre) ? 'GSM (160 par SMS)' : 'Unicode (70 par SMS)',
    corriges: perdus.slice(0, 12),
    segments_avant: segments(brut)
  };
}
