// /api/ringover-record.js — Proxy des enregistrements Ringover.
// Pourquoi : le CDN Ringover sert les .mp3 SANS Content-Type + avec nosniff → le lecteur <audio>
// refuse de jouer. Ce proxy re-sert le fichier avec Content-Type: audio/mpeg + support des plages
// (seeking), en same-origin (donc plus de souci de CSP non plus).
//
// GET ?url=<URL cdn.ringover.com/records/...>
// Sécurité : on n'accepte QUE les URLs d'enregistrements Ringover (anti-SSRF / open proxy).
// Pas d'auth : ces URLs sont déjà publiques côté Ringover (UUID indevinable) → aucune exposition nouvelle.

export default async function handler(req, res) {
  const url = String(req.query.url || '');
  if (!/^https:\/\/cdn\.ringover\.com\/records\//.test(url)) {
    return res.status(400).json({ erreur: 'URL non autorisée (enregistrements Ringover uniquement)' });
  }
  // Le CDN Ringover a des ratés transitoires. Trois règles apprises de l'alerte Vercel du 20/08
  // (« 500 errors amid CDN fetch failures ») :
  //  · une panne chez EUX ne doit pas remonter en 500 chez nous — un 500 déclenche l'alerte
  //    d'anomalie et fait croire à un incident Sofy ;
  //  · toujours un délai d'attente : sans lui, un CDN lent occupe la fonction jusqu'au bout ;
  //  · une seconde tentative suffit à absorber l'essentiel des ratés.
  const chercher = async () => {
    // On propage la plage demandée : quand le CDN la gère, on ne télécharge plus tout le fichier.
    const entetes = req.headers.range ? { Range: req.headers.range } : {};
    return fetch(url, { headers: entetes, signal: AbortSignal.timeout(15000) });
  };
  let upstream;
  try {
    try { upstream = await chercher(); }
    catch (e1) {
      await new Promise(r => setTimeout(r, 700));
      upstream = await chercher();
    }
  } catch (e) {
    const expire = /abort|timeout/i.test(String(e && (e.name + e.message)));
    return res.status(expire ? 504 : 502).json({
      erreur: expire ? 'Le CDN Ringover n\'a pas répondu à temps' : 'Le CDN Ringover est injoignable',
      detail: 'Réessaie dans un instant : l\'enregistrement est chez Ringover, pas chez Sofy.',
      amont: String((e && e.message) || e).slice(0, 120)
    });
  }
  try {
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status === 404 ? 404 : 502).json({
        erreur: upstream.status === 404 ? 'Enregistrement introuvable chez Ringover' : 'Le CDN Ringover a refusé la requête',
        status: upstream.status
      });
    }
    // Plage servie directement par le CDN : on relaie sans rien recomposer.
    if (upstream.status === 206 && req.headers.range) {
      const cr = upstream.headers.get('content-range');
      const brut = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = 206;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Content-Length', brut.length);
      return res.end(brut);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const total = buf.length;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Support des requêtes "Range" (seeking) — Ringover ne les gère pas, on les gère nous-mêmes.
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const chunk = buf.subarray(start, end + 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunk.length);
      return res.end(chunk);
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', total);
    return res.end(buf);
  } catch (e) {
    // Ici, l'échec est de NOTRE côté (lecture du flux, mémoire) : le 502 reste réservé à l'amont.
    return res.status(502).json({ erreur: 'Lecture de l\'enregistrement interrompue', detail: String(e.message || e).slice(0, 200) });
  }
}
