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
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ erreur: 'Enregistrement introuvable', status: upstream.status });
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
    return res.status(500).json({ erreur: 'Proxy audio échoué', detail: String(e.message || e).slice(0, 200) });
  }
}
