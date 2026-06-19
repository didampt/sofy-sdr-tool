// /api/basile-debug8.js — TEMPORAIRE — DÉCISIF : les LEADS sont-ils filtrés (vs le total qui ment) ?
import { verifierToken } from './db.js';
async function leads(filters, key){
  try{
    const r=await fetch('https://api.basile.cc/people/find',{method:'POST',headers:{'Authorization':key,'Content-Type':'application/json'},body:JSON.stringify({limit:10,filters})});
    const d=await r.json().catch(()=>null);
    return {
      status:r.status,
      total:d?.total??null,
      nb_leads:(d?.leads||[]).length,
      postes:(d?.leads||[]).map(l=>(l.data||{}).current_job_title||'(vide)'),
      regions:(d?.leads||[]).map(l=>(l.data||{}).location_region||'(null)'),
      villes:(d?.leads||[]).map(l=>(l.data||{}).location_city||'(null)')
    };
  }catch(e){return {erreur:String(e.message||e).slice(0,80)};}
}
export default async function handler(req,res){
  const user=verifierToken(req);
  if(!user)return res.status(401).json({erreur:'Non authentifié'});
  if(user.role!=='superadmin')return res.status(403).json({erreur:'Réservé superadmin'});
  const key=process.env.BASILE_API_KEY;
  if(!key)return res.status(500).json({erreur:'BASILE_API_KEY manquante'});

  const out={};
  // A) AUCUN filtre (juste limit) — à quoi ressemblent les leads "bruts" ?
  out.A_aucun_filtre=await leads({},key);
  // B) Filtre poste très spécifique
  out.B_poste_DC=await leads({current_job_title:{include:['Directeur Commercial']}},key);
  // C) Filtre poste exotique (devrait donner des leads différents SI le filtre marche)
  out.C_poste_dev=await leads({current_job_title:{include:['Développeur']}},key);
  // D) Filtre ville Paris
  out.D_ville_Paris=await leads({location_city:{include:['Paris']}},key);

  return res.status(200).json({
    note:'Compare les POSTES entre B et C. Si B montre des Directeurs Commerciaux et C des Développeurs, le filtre leads MARCHE (seul le total ment). Si A=B=C (mêmes leads), Basile ne filtre RIEN.',
    out
  });
}
