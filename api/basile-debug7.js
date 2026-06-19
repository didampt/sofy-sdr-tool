// /api/basile-debug7.js — TEMPORAIRE — isole le bon filtre géographique (région/DOM).
import { verifierToken } from './db.js';
async function cnt(filters, key){
  try{
    const r=await fetch('https://api.basile.cc/people/find',{method:'POST',headers:{'Authorization':key,'Content-Type':'application/json'},body:JSON.stringify({limit:3,filters})});
    const d=await r.json().catch(()=>null);
    return {status:r.status,total:d?.total??null,regionsVues:[...new Set((d?.leads||[]).map(l=>(l.data||{}).location_region))].slice(0,8)};
  }catch(e){return {erreur:String(e.message||e).slice(0,80)};}
}
export default async function handler(req,res){
  const user=verifierToken(req);
  if(!user)return res.status(401).json({erreur:'Non authentifié'});
  if(user.role!=='superadmin')return res.status(403).json({erreur:'Réservé superadmin'});
  const key=process.env.BASILE_API_KEY;
  if(!key)return res.status(500).json({erreur:'BASILE_API_KEY manquante'});
  const poste={current_job_title:{include:['Directeur Commercial']}};
  const tests={};
  // Référence : poste + FR (sans géo)
  tests.REF_poste_FR=await cnt({...poste,location_country_code:{include:['FR']}},key);
  // T1 : location_region = Martinique
  tests.T1_region_Martinique=await cnt({...poste,location_region:{include:['Martinique']}},key);
  // T2 : location_region = Reunion (sans accent)
  tests.T2_region_Reunion=await cnt({...poste,location_region:{include:['Reunion']}},key);
  // T3 : location_city = Fort-de-France
  tests.T3_city_FDF=await cnt({...poste,location_city:{include:['Fort-de-France']}},key);
  // T4 : location_region SANS le filtre pays (peut-être incompatibles ensemble)
  tests.T4_region_sans_pays=await cnt({...poste,location_region:{include:['Martinique']}},key);
  // T5 : sans poste, juste région (la région filtre-t-elle seule ?)
  tests.T5_region_seule=await cnt({location_region:{include:['Martinique']}},key);
  // T6 : sans poste, juste ville
  tests.T6_ville_seule=await cnt({location_city:{include:['Fort-de-France']}},key);
  // T7 : pays GP (code DOM ?) au lieu de FR
  tests.T7_pays_GP=await cnt({...poste,location_country_code:{include:['GP']}},key);
  return res.status(200).json({note:'REF doit être élevé. Un test qui CHUTE sous REF = ce filtre marche. Si tout = REF, le filtre est ignoré.',tests});
}
