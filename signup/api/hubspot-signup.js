const HS = 'https://api.hubapi.com';
const FREE_EMAIL_DOMAIN = /^(gmail|outlook|hotmail|yahoo|orange|wanadoo|free|sfr|laposte|icloud|live)\./i;
const propertyCache = new Map();

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function domainFromEmail(email) {
  const value = clean(email).toLowerCase();
  if (!value.includes('@')) return '';
  const domain = value.split('@').pop();
  return FREE_EMAIL_DOMAIN.test(domain) ? '' : domain;
}

async function hs(path, method, token, body) {
  const response = await fetch(HS + path, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function getProperties(objectType, token) {
  const key = objectType;
  const cached = propertyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await hs(`/crm/v3/properties/${objectType}?archived=false`, 'GET', token);
  const props = {
    byName: new Map(),
    all: [],
    available: response.ok
  };

  if (response.ok) {
    for (const prop of response.data.results || []) {
      const readOnly = prop.modificationMetadata && prop.modificationMetadata.readOnlyValue;
      if (readOnly || prop.calculated) continue;
      props.byName.set(prop.name, prop);
      props.all.push(prop);
    }
  }

  propertyCache.set(key, { expiresAt: Date.now() + 10 * 60 * 1000, value: props });
  return props;
}

function findProperty(properties, candidates) {
  const names = candidates.map(clean).filter(Boolean);
  for (const name of names) {
    const direct = properties.byName.get(name);
    if (direct) return direct;
  }
  const normalized = new Set(names.map(normalizeKey));
  return properties.all.find(prop => normalized.has(normalizeKey(prop.label)) || normalized.has(normalizeKey(prop.name))) || null;
}

function enumCandidate(prop, values) {
  const options = prop.options || [];
  const candidates = values.map(clean).filter(Boolean);
  const normalized = new Set(candidates.map(normalizeKey));
  return options.find(option =>
    candidates.includes(option.value) ||
    candidates.includes(option.label) ||
    normalized.has(normalizeKey(option.value)) ||
    normalized.has(normalizeKey(option.label))
  );
}

function setProperty(target, prop, values) {
  if (!prop) return false;
  const list = Array.isArray(values) ? values : [values];
  const first = list.map(v => (v === undefined || v === null ? '' : String(v).trim())).find(Boolean);
  if (!first) return false;

  if (prop.type === 'enumeration' || prop.fieldType === 'select' || prop.fieldType === 'radio') {
    const option = enumCandidate(prop, list);
    if (!option) return false;
    target[prop.name] = option.value;
    return true;
  }

  if (prop.type === 'number') {
    const numeric = Number(String(first).replace(',', '.'));
    if (!Number.isFinite(numeric)) return false;
    target[prop.name] = numeric;
    return true;
  }

  target[prop.name] = first.slice(0, 5000);
  return true;
}

function pappersRaw(company) {
  return company && company.pappers_raw && typeof company.pappers_raw === 'object' ? company.pappers_raw : {};
}

function establishmentCount(company) {
  const raw = pappersRaw(company);
  const value = company.nb_establishments ||
    company.nombre_etablissements ||
    raw.nombre_etablissements_ouverts ||
    raw.nombre_etablissements ||
    raw.etablissements_count ||
    '';
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : clean(value, 80);
}

function establishmentCandidates(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return [value];
  if (n === 1) return [String(n), '1', '1 établissement', 'mono_etablissement'];
  if (n <= 5) return [String(n), '2_5', '2 à 5 établissements', '2-5'];
  if (n <= 20) return [String(n), '6_20', '6 à 20 établissements', '6-20'];
  if (n <= 50) return [String(n), '21_50', '21 à 50 établissements', '21-50'];
  return [String(n), '51_plus', '51 établissements et plus', '51+'];
}

function sectorCandidates(company) {
  const signupSector = clean(company.secteur, 200);
  const raw = pappersRaw(company);
  const activity = clean(company.activity || raw.libelle_code_naf || raw.code_naf || '', 300);
  const text = normalizeKey(`${activity} ${raw.code_naf || ''}`);
  const candidates = [signupSector, activity];

  if (/restaur|hotel|heberg|bar|cafe|traiteur/.test(text)) candidates.push('restauration_hotellerie', 'Restauration / hôtellerie');
  if (/commerce|detail|retail|magasin|boutique/.test(text)) candidates.push('commerce_retail', 'Commerce / retail');
  if (/sante|medical|bienetre|beaute|coiffure|estheti/.test(text)) candidates.push('sante_bien_etre', 'Santé / bien-être');
  if (/immobilier/.test(text)) candidates.push('immobilier', 'Immobilier');
  if (/auto|vehicule|garage|carrosserie/.test(text)) candidates.push('automobile', 'Automobile');
  if (/enseignement|formation|education/.test(text)) candidates.push('education_formation', 'Éducation / formation');
  if (/banque|assurance|financ/.test(text)) candidates.push('banque_assurance', 'Banque / assurance');
  if (/tourisme|loisir|sport|voyage/.test(text)) candidates.push('tourisme_loisirs', 'Tourisme / loisirs');
  if (/franchise|reseau/.test(text)) candidates.push('franchise_reseau', 'Franchise / réseau');
  if (activity) candidates.push('Services', 'services');

  return candidates;
}

function trafficLabel(tracking) {
  const original = (tracking && tracking.original) || {};
  const utmSource = clean(original.utm_source, 120);
  const utmMedium = clean(original.utm_medium, 120);
  const utmCampaign = clean(original.utm_campaign, 120);
  if (utmSource) return [utmSource, utmMedium, utmCampaign].filter(Boolean).join(' / ');

  const referrer = clean(original.referrer, 1000);
  if (referrer) {
    try { return new URL(referrer).hostname.replace(/^www\./, ''); } catch (_) { return referrer.slice(0, 120); }
  }

  return 'signup.sofy.fr';
}

function trafficDetails(tracking) {
  const original = (tracking && tracking.original) || {};
  const current = (tracking && tracking.current) || {};
  const lines = [
    ['Source origine', trafficLabel(tracking)],
    ['Landing page origine', original.landing_page],
    ['Referrer origine', original.referrer],
    ['UTM source', original.utm_source],
    ['UTM medium', original.utm_medium],
    ['UTM campaign', original.utm_campaign],
    ['UTM term', original.utm_term],
    ['UTM content', original.utm_content],
    ['GCLID', original.gclid],
    ['FBCLID', original.fbclid],
    ['MSCLKID', original.msclkid],
    ['Dernière page', current.landing_page]
  ];
  return lines
    .map(([label, value]) => [label, clean(value, 1000)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

function html(text) {
  return clean(text, 12000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

async function searchOne(objectType, token, filters, properties = []) {
  const response = await hs(`/crm/v3/objects/${objectType}/search`, 'POST', token, {
    filterGroups: [{ filters }],
    properties,
    limit: 1
  });
  if (!response.ok || !response.data.total) return null;
  return response.data.results[0];
}

async function upsertContact({ body, contactProps, token }) {
  const email = clean(body.email).toLowerCase();
  const existing = email ? await searchOne('contacts', token, [{ propertyName: 'email', operator: 'EQ', value: email }], ['email']) : null;
  if (existing && existing.id) {
    const patch = await hs(`/crm/v3/objects/contacts/${existing.id}`, 'PATCH', token, { properties: contactProps });
    if (!patch.ok) throw new Error(patch.data.message || `HubSpot contact PATCH HTTP ${patch.status}`);
    return { id: existing.id, created: false };
  }

  const create = await hs('/crm/v3/objects/contacts', 'POST', token, { properties: contactProps });
  if (!create.ok) throw new Error(create.data.message || `HubSpot contact POST HTTP ${create.status}`);
  return { id: create.data.id, created: true };
}

async function upsertCompany({ body, companyProps, companyMeta, token }) {
  const company = body.company || {};
  const name = clean(company.name, 300);
  if (!name) return { id: null, created: false };

  const domain = domainFromEmail(body.email);
  const siret = clean(company.siret, 30);
  const siretProp = findProperty(companyMeta, [process.env.HUBSPOT_SIGNUP_COMPANY_SIRET_PROPERTY, 'siret']);

  let existing = null;
  if (siret && siretProp) {
    existing = await searchOne('companies', token, [{ propertyName: siretProp.name, operator: 'EQ', value: siret }], ['name']);
  }
  if (!existing && domain) {
    existing = await searchOne('companies', token, [{ propertyName: 'domain', operator: 'EQ', value: domain }], ['name']);
  }
  if (!existing && name) {
    existing = await searchOne('companies', token, [{ propertyName: 'name', operator: 'EQ', value: name }], ['name']);
  }

  if (existing && existing.id) {
    const patch = await hs(`/crm/v3/objects/companies/${existing.id}`, 'PATCH', token, { properties: companyProps });
    if (!patch.ok) throw new Error(patch.data.message || `HubSpot company PATCH HTTP ${patch.status}`);
    return { id: existing.id, created: false };
  }

  const create = await hs('/crm/v3/objects/companies', 'POST', token, { properties: companyProps });
  if (!create.ok) throw new Error(create.data.message || `HubSpot company POST HTTP ${create.status}`);
  return { id: create.data.id, created: true };
}

async function associateContactCompany({ contactId, companyId, token }) {
  if (!contactId || !companyId) return null;
  return hs(`/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, 'PUT', token);
}

async function createSignupNote({ body, contactId, companyId, token }) {
  if (!contactId && !companyId) return null;
  const company = body.company || {};
  const fonction = clean(body.fonction || process.env.HUBSPOT_SIGNUP_DEFAULT_FONCTION || 'Inscription signup', 200);
  const lines = [
    '<b>Nouvelle inscription Sofy</b>',
    `Contact: ${html(`${body.first_name || ''} ${body.last_name || ''}`.trim())} (${html(body.email || '')})`,
    `Société: ${html(company.name || '')}`,
    `Pays: ${html(body.country || '')}`,
    `Fonction: ${html(fonction)}`,
    `Secteur: ${html(sectorCandidates(company)[0] || '')}`,
    `Nombre d'établissements: ${html(establishmentCount(company) || '')}`,
    '',
    html(trafficDetails(body.tracking))
  ].filter(line => line !== '').join('<br>');

  const associations = [];
  if (contactId) associations.push({ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] });
  if (companyId) associations.push({ to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }] });

  return hs('/crm/v3/objects/notes', 'POST', token, {
    properties: { hs_note_body: lines.slice(0, 9000), hs_timestamp: Date.now() },
    associations
  });
}

function addConfiguredTrackingProperties(props, meta, prefix, tracking) {
  const source = trafficLabel(tracking);
  const details = trafficDetails(tracking);
  setProperty(props, findProperty(meta, [
    process.env[`${prefix}_TRAFFIC_SOURCE_PROPERTY`],
    'source_trafic_origine',
    'origine_trafic',
    'traffic_source_origin',
    'original_traffic_source',
    'utm_source'
  ]), [source]);
  setProperty(props, findProperty(meta, [
    process.env[`${prefix}_TRAFFIC_DETAIL_PROPERTY`],
    'detail_source_trafic',
    'traffic_source_detail',
    'original_traffic_detail'
  ]), [details]);
}

export async function syncSignupToHubSpot(body) {
  const token = clean(process.env.HUBSPOT_API_KEY, 2000);
  if (!token) return { ok: false, skipped: true, raison: 'HUBSPOT_API_KEY non configurée' };

  const company = body.company || {};
  const contactMeta = await getProperties('contacts', token);
  const companyMeta = await getProperties('companies', token);
  const domain = domainFromEmail(body.email);
  const fonction = clean(body.fonction || process.env.HUBSPOT_SIGNUP_DEFAULT_FONCTION || 'Inscription signup', 200);

  const contactProps = compactObject({
    email: clean(body.email).toLowerCase(),
    firstname: clean(body.first_name, 200),
    lastname: clean(body.last_name, 200),
    phone: clean(body.phone, 80),
    mobilephone: clean(body.phone, 80),
    company: clean(company.name, 300),
    jobtitle: fonction,
    country: clean(body.country, 200),
    hs_lead_status: 'OPEN'
  });

  setProperty(contactProps, findProperty(contactMeta, [
    process.env.HUBSPOT_SIGNUP_CONTACT_FUNCTION_PROPERTY,
    'revops_fonction',
    'fonction',
    'job_function'
  ]), [body.fonction, fonction, process.env.HUBSPOT_SIGNUP_DEFAULT_FONCTION, 'autre', 'Autre']);
  addConfiguredTrackingProperties(contactProps, contactMeta, 'HUBSPOT_SIGNUP_CONTACT', body.tracking);

  const etabs = establishmentCount(company);
  const companyProps = compactObject({
    name: clean(company.name, 300),
    domain: domain || undefined,
    country: clean(body.country, 200),
    phone: clean(body.phone, 80),
    city: clean(company.city, 200),
    address: clean(company.address, 500),
    zip: clean(company.postal_code, 80)
  });

  setProperty(companyProps, findProperty(companyMeta, [
    process.env.HUBSPOT_SIGNUP_COMPANY_SECTOR_PROPERTY,
    'revops_secteur',
    'secteur',
    'company_sector',
    'industry'
  ]), sectorCandidates(company));
  setProperty(companyProps, findProperty(companyMeta, [
    process.env.HUBSPOT_SIGNUP_COMPANY_ESTABLISHMENTS_PROPERTY,
    'nombre_d_etablissements',
    'nombre_etablissements',
    'nb_etablissements',
    'number_of_locations',
    'nombre_etablissements_ouverts'
  ]), establishmentCandidates(etabs));
  setProperty(companyProps, findProperty(companyMeta, [
    process.env.HUBSPOT_SIGNUP_COMPANY_SIRET_PROPERTY,
    'siret'
  ]), [company.siret]);
  setProperty(companyProps, findProperty(companyMeta, [
    process.env.HUBSPOT_SIGNUP_COMPANY_SIREN_PROPERTY,
    'siren'
  ]), [company.siren]);
  setProperty(companyProps, findProperty(companyMeta, [
    process.env.HUBSPOT_SIGNUP_COMPANY_TVA_PROPERTY,
    'numero_de_tva'
  ]), [company.tva_id]);
  addConfiguredTrackingProperties(companyProps, companyMeta, 'HUBSPOT_SIGNUP_COMPANY', body.tracking);

  const contact = await upsertContact({ body, contactProps, token });
  const companyResult = await upsertCompany({ body, companyProps, companyMeta, token });
  const warnings = [];

  const association = await associateContactCompany({ contactId: contact.id, companyId: companyResult.id, token });
  if (association && !association.ok) warnings.push(`Association HubSpot ignorée: HTTP ${association.status}`);

  const note = await createSignupNote({ body, contactId: contact.id, companyId: companyResult.id, token });
  if (note && !note.ok) warnings.push(`Note HubSpot ignorée: ${note.data.message || `HTTP ${note.status}`}`);

  return {
    ok: true,
    contactId: contact.id,
    companyId: companyResult.id,
    contactCreated: contact.created,
    companyCreated: companyResult.created,
    noteId: note && note.ok ? note.data.id || null : null,
    warnings
  };
}
