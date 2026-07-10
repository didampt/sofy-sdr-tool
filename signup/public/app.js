import { getCountryCallingCode, parsePhoneNumberFromString } from 'https://cdn.jsdelivr.net/npm/libphonenumber-js@1.11.20/+esm';

const ISO_COUNTRIES = [
  'AF','AX','AL','DZ','AS','AD','AO','AI','AQ','AG','AR','AM','AW','AU','AT','AZ',
  'BS','BH','BD','BB','BY','BE','BZ','BJ','BM','BT','BO','BQ','BA','BW','BV','BR','IO','BN','BG','BF','BI',
  'KH','CM','CA','CV','KY','CF','TD','CL','CN','CX','CC','CO','KM','CG','CD','CK','CR','CI','HR','CU','CW','CY','CZ',
  'DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FK','FO','FJ','FI','FR','GF','PF','TF',
  'GA','GM','GE','DE','GH','GI','GR','GL','GD','GP','GU','GT','GG','GN','GW','GY',
  'HT','HM','VA','HN','HK','HU','IS','IN','ID','IR','IQ','IE','IM','IL','IT',
  'JM','JP','JE','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU',
  'MO','MG','MW','MY','MV','ML','MT','MH','MQ','MR','MU','YT','MX','FM','MD','MC','MN','ME','MS','MA','MZ','MM',
  'NA','NR','NP','NL','NC','NZ','NI','NE','NG','NU','NF','MK','MP','NO','OM',
  'PK','PW','PS','PA','PG','PY','PE','PH','PN','PL','PT','PR','QA','RE','RO','RU','RW',
  'BL','SH','KN','LC','MF','PM','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SX','SK','SI','SB','SO','ZA','GS','SS','ES','LK','SD','SR','SJ','SE','CH','SY',
  'TW','TJ','TZ','TH','TL','TG','TK','TO','TT','TN','TR','TM','TC','TV',
  'UG','UA','AE','GB','US','UM','UY','UZ','VU','VE','VN','VG','VI',
  'WF','EH','YE','ZM','ZW'
];

const FRENCH_CODES = new Set(['FR', 'GP', 'MQ', 'RE', 'GF', 'YT', 'PM', 'BL', 'MF', 'WF', 'PF', 'NC', 'TF']);
const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });

const countries = ISO_COUNTRIES.map(code => {
  let dialCode = '';
  try {
    dialCode = `+${getCountryCallingCode(code)}`;
  } catch {}
  return {
    code,
    name: regionNames.of(code) || code,
    dialCode,
    flag: flagEmoji(code),
    search: ''
  };
}).map(country => ({
  ...country,
  search: `${country.name} ${country.code} ${country.dialCode}`.toLowerCase()
})).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

const form = document.querySelector('#signupForm');
const phoneInput = document.querySelector('#phone');
const companySection = document.querySelector('#companySection');
const companyName = document.querySelector('#companyName');
const companyResults = document.querySelector('#companyResults');
const frenchCompanyFields = document.querySelector('#frenchCompanyFields');
const submitBtn = document.querySelector('#submitBtn');
const formError = document.querySelector('#formError');
const password = document.querySelector('#password');
const passwordStrength = document.querySelector('#passwordStrength');
const togglePassword = document.querySelector('#togglePassword');
const otpSection = document.querySelector('#otpSection');
const otpCode = document.querySelector('#otpCode');
const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));
const resendOtpBtn = document.querySelector('#resendOtpBtn');
const countryCodeInput = document.querySelector('#countryCode');
const phoneCountryInput = document.querySelector('#phoneCountry');
const moduleSlides = Array.from(document.querySelectorAll('.module-slide'));
const moduleButtons = Array.from(document.querySelectorAll('.slide-controls button'));
const moduleSlider = document.querySelector('.module-slider');
const storyTitle = document.querySelector('.story-head h2');
const storyDescription = document.querySelector('.story-head p');

const moduleStories = [
  {
    title: 'Soyez visible là où vos clients vous cherchent.',
    description: 'SO-VIEW centralise vos fiches Google, vos avis et vos priorités locales pour faire progresser chaque établissement.'
  },
  {
    title: 'Activez vos audiences locales au bon moment.',
    description: 'SO-REACH vous aide à créer, segmenter et mesurer vos campagnes SMS, RCS et email depuis une seule interface.'
  },
  {
    title: 'Transformez chaque conversation en opportunité.',
    description: 'SO-CONNECT regroupe vos canaux entrants et aide vos équipes à répondre plus vite avec le contexte client.'
  },
  {
    title: 'Budy IA accompagne chaque module Sofy.',
    description: 'L’IA rédige, analyse, répond, qualifie et recommande les prochaines actions pour accélérer votre marketing local.'
  }
];

let selectedCompanyRaw = null;
let selectedCompanyLegalForm = '';
let selectedCompanyActivity = '';
let abortSearch = null;
let signupCompleted = false;
let otpToken = '';
let previewMode = '';
let pendingSignupPayload = null;
const searchCache = new Map();
const attribution = initAttribution();

const countryCombo = createCombo({
  root: document.querySelector('#countryCombo'),
  trigger: document.querySelector('#countryTrigger'),
  menu: document.querySelector('#countryMenu'),
  search: document.querySelector('#countrySearch'),
  options: document.querySelector('#countryOptions'),
  input: countryCodeInput,
  items: countries,
  formatTrigger: item => item.name,
  formatOption: item => item.name,
  meta: item => item.code
});

const phoneCombo = createCombo({
  root: document.querySelector('#phoneCountryCombo'),
  trigger: document.querySelector('#phoneCountryTrigger'),
  menu: document.querySelector('#phoneCountryMenu'),
  search: document.querySelector('#phoneCountrySearch'),
  options: document.querySelector('#phoneCountryOptions'),
  input: phoneCountryInput,
  items: countries.filter(country => country.dialCode),
  formatTrigger: item => item.dialCode,
  formatOption: item => item.name,
  meta: item => item.dialCode
});

function flagEmoji(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/./g, char => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

function setError(message, kind = 'error') {
  formError.hidden = !message;
  formError.classList.toggle('is-info', kind === 'info');
  formError.innerHTML = message || '';
}

function byCode(code) {
  return countries.find(country => country.code === code);
}

function selectedCountry() {
  return byCode(countryCodeInput.value);
}

function isFrenchCompanyCountry() {
  const country = selectedCountry();
  return Boolean(country && FRENCH_CODES.has(country.code));
}

function updateCompanyVisibility() {
  const frenchCompany = isFrenchCompanyCountry();
  companySection.hidden = false;
  companyName.required = true;
  frenchCompanyFields.hidden = !frenchCompany;
  document.querySelector('#siret').required = frenchCompany;
  document.querySelector('#tvaId').required = false;
  if (!frenchCompany) {
    selectedCompanyRaw = null;
    selectedCompanyLegalForm = '';
    selectedCompanyActivity = '';
    document.querySelector('#siret').value = '';
    document.querySelector('#tvaId').value = '';
    companyResults.hidden = true;
    companyResults.innerHTML = '';
  }
}

function passwordIssue(value) {
  if (value.length < 12) return '12 caractères minimum.';
  if (!/[a-z]/.test(value)) return 'Ajoutez une minuscule.';
  if (!/[A-Z]/.test(value)) return 'Ajoutez une majuscule.';
  if (!/[0-9]/.test(value)) return 'Ajoutez un chiffre.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Ajoutez un symbole.';
  return '';
}

function updatePasswordHelp() {
  const issue = passwordIssue(password.value);
  passwordStrength.parentElement.classList.toggle('good', !issue && password.value.length > 0);
  passwordStrength.parentElement.classList.toggle('bad', Boolean(issue && password.value.length > 0));
  passwordStrength.textContent = issue || 'Mot de passe solide.';
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function fillCompany(company) {
  selectedCompanyRaw = company.pappers_raw || null;
  selectedCompanyLegalForm = company.legal_form || '';
  selectedCompanyActivity = company.activity || '';
  companyName.value = company.name || '';
  document.querySelector('#siret').value = company.siret || '';
  document.querySelector('#tvaId').value = company.tva_id || company.numero_tva_intracommunautaire || '';
  document.querySelector('#address').value = company.address || '';
  document.querySelector('#postalCode').value = company.postal_code || '';
  document.querySelector('#city').value = company.city || '';
  companyResults.hidden = true;
  companyResults.innerHTML = '';
  companyName.setAttribute('aria-expanded', 'false');
}

function clearCompanyDetails() {
  selectedCompanyRaw = null;
  selectedCompanyLegalForm = '';
  selectedCompanyActivity = '';
  document.querySelector('#siret').value = '';
  document.querySelector('#tvaId').value = '';
  document.querySelector('#address').value = '';
  document.querySelector('#postalCode').value = '';
  document.querySelector('#city').value = '';
}

function setCompanyLoading(loading) {
  companySection.classList.toggle('is-loading', loading);
  companySection.setAttribute('aria-busy', String(loading));
}

async function selectCompany(company) {
  companyName.value = company.name || '';
  companyResults.hidden = true;
  companyResults.innerHTML = '';
  companyName.setAttribute('aria-expanded', 'false');
  clearCompanyDetails();
  setCompanyLoading(true);

  const siret = String(company.siret || '').replace(/\D/g, '');
  if (siret.length !== 14) {
    fillCompany(company);
    setCompanyLoading(false);
    return;
  }
  try {
    const response = await fetch(`/api/pappers-company?siret=${encodeURIComponent(siret)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erreur Pappers');
    fillCompany(data.company ? { ...company, ...data.company } : company);
  } catch (_) {
    fillCompany(company);
  } finally {
    setCompanyLoading(false);
  }
}

function renderCompanies(companies) {
  if (!companies.length) {
    companyResults.innerHTML = '<div class="suggestions-empty">Aucune entreprise trouvée. Vous pouvez saisir les informations manuellement.</div>';
    companyResults.hidden = false;
    companyName.setAttribute('aria-expanded', 'true');
    return;
  }
  companyResults.innerHTML = companies.map((company, index) => `
    <button type="button" role="option" data-index="${index}">
      <span>${company.name || 'Entreprise sans nom'}</span>
      <small>${company.siret || 'SIRET indisponible'}${company.city ? ` · ${company.city}` : ''}</small>
    </button>
  `).join('');
  companyResults.hidden = false;
  companyName.setAttribute('aria-expanded', 'true');
  companyResults.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => selectCompany(companies[Number(button.dataset.index)]));
  });
}

function renderCompanyLoading() {
  companyResults.innerHTML = `
    <div class="suggestions-loading">
      <span class="suggestions-spinner" aria-hidden="true"></span>
      Recherche en cours ...
    </div>
  `;
  companyResults.hidden = false;
  companyName.setAttribute('aria-expanded', 'true');
}

const searchCompany = debounce(async () => {
  const q = companyName.value.trim();
  selectedCompanyRaw = null;
  selectedCompanyLegalForm = '';
  selectedCompanyActivity = '';
  document.querySelector('#tvaId').value = '';
  if (q.length < 3 || !isFrenchCompanyCountry()) {
    companyResults.hidden = true;
    companyName.setAttribute('aria-expanded', 'false');
    return;
  }

  if (searchCache.has(q.toLowerCase())) {
    renderCompanies(searchCache.get(q.toLowerCase()));
    return;
  }

  if (abortSearch) abortSearch.abort();
  abortSearch = new AbortController();
  renderCompanyLoading();

  try {
    const response = await fetch(`/api/pappers-search?q=${encodeURIComponent(q)}`, { signal: abortSearch.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erreur Pappers');
    const companies = data.companies || [];
    searchCache.set(q.toLowerCase(), companies);
    renderCompanies(companies);
  } catch (err) {
    if (err.name === 'AbortError') return;
    companyResults.innerHTML = `<div class="suggestions-empty">${err.message}</div>`;
    companyResults.hidden = false;
    companyName.setAttribute('aria-expanded', 'true');
  }
}, 260);

function formPayload() {
  const country = selectedCountry();
  const data = new FormData(form);
  return {
    first_name: String(data.get('first_name') || '').trim(),
    last_name: String(data.get('last_name') || '').trim(),
    email: String(data.get('email') || '').trim(),
    phone: phoneInput.value.trim(),
    phone_country: phoneCountryInput.value,
    country: country ? country.name : '',
    country_code: country ? country.code : '',
    password: password.value,
    cgv_accepted: document.querySelector('#cgv').checked,
    company: {
      name: companyName.value.trim(),
      siret: document.querySelector('#siret').value.replace(/\D/g, ''),
      tva_id: document.querySelector('#tvaId').value.trim(),
      address: document.querySelector('#address').value.trim(),
      postal_code: document.querySelector('#postalCode').value.trim(),
      city: document.querySelector('#city').value.trim(),
      legal_form: selectedCompanyLegalForm,
      activity: selectedCompanyActivity,
      manual_entry: !selectedCompanyRaw,
      pappers_raw: selectedCompanyRaw
    },
    tracking: attribution
  };
}

function initAttribution() {
  const storageKey = 'sofy_signup_attribution_v1';
  const current = trafficSnapshot();
  let original = null;

  try {
    original = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
  } catch (_) {}

  if (!original || typeof original !== 'object' || !original.first_seen_at) {
    original = { ...current, first_seen_at: new Date().toISOString() };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(original));
    } catch (_) {}
  }

  return { original, current: { ...current, seen_at: new Date().toISOString() } };
}

function trafficSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const pick = name => String(params.get(name) || '').trim();
  return {
    landing_page: window.location.href,
    referrer: document.referrer || '',
    utm_source: pick('utm_source'),
    utm_medium: pick('utm_medium'),
    utm_campaign: pick('utm_campaign'),
    utm_term: pick('utm_term'),
    utm_content: pick('utm_content'),
    gclid: pick('gclid'),
    fbclid: pick('fbclid'),
    msclkid: pick('msclkid'),
    ttclid: pick('ttclid'),
    li_fat_id: pick('li_fat_id')
  };
}

function validateClient(payload) {
  const errors = [];
  if (!payload.first_name) errors.push('Le prénom est requis.');
  if (!payload.last_name) errors.push('Le nom est requis.');
  if (!payload.country_code) errors.push('Le pays est requis.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.push('Un email valide est requis.');
  const phone = parsePhoneNumberFromString(payload.phone, payload.phone_country);
  if (!phone || !phone.isValid()) errors.push('Un numéro de téléphone valide est requis.');
  const pass = passwordIssue(payload.password);
  if (pass) errors.push(pass);
  if (!payload.company.name) errors.push('La raison sociale est requise.');
  if (FRENCH_CODES.has(payload.country_code)) {
    if (!/^\d{14}$/.test(payload.company.siret)) errors.push('Un SIRET valide est requis.');
  }
  if (!payload.cgv_accepted) errors.push('Vous devez accepter les CGV.');
  return errors;
}

function otpPayload(payload) {
  return {
    ...payload,
    otp_token: otpToken,
    otp_code: otpCode.value.trim()
  };
}

function otpValue() {
  return otpBoxes.map(box => box.value).join('');
}

function setOtpValue(value, focusIndex, shouldFocus = true) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  otpBoxes.forEach((box, index) => {
    box.value = digits[index] || '';
    box.classList.toggle('is-filled', Boolean(box.value));
  });
  otpCode.value = digits;
  const nextIndex = focusIndex ?? Math.min(digits.length, otpBoxes.length - 1);
  if (shouldFocus && otpBoxes[nextIndex]) otpBoxes[nextIndex].focus();
}

function showOtpStep() {
  form.classList.add('is-otp-step');
  otpSection.hidden = false;
  otpCode.required = true;
  if (previewMode !== 'otp-sent') {
    const firstEmpty = otpBoxes.findIndex(box => !box.value);
    (otpBoxes[firstEmpty === -1 ? otpBoxes.length - 1 : firstEmpty] || otpCode).focus();
  }
  submitBtn.textContent = 'Valider le code et créer mon compte';
}

function resetOtpStep() {
  otpToken = '';
  pendingSignupPayload = null;
  form.classList.remove('is-otp-step');
  otpSection.hidden = true;
  otpCode.required = false;
  setOtpValue('', 0, false);
  if (!signupCompleted) submitBtn.textContent = 'Créer mon compte';
}

async function requestOtp(payload) {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Envoi du code...';
  try {
    const response = await fetch('/api/signup-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = data.errors ? data.errors.join('<br>') : (data.detail || data.error || 'Erreur inconnue');
      throw new Error(details);
    }
    otpToken = data.otp_token || '';
    if (!otpToken) throw new Error('Code envoyé, mais jeton de validation manquant.');
    pendingSignupPayload = payload;
    showOtpStep();
    setError('<div>Code envoyé par SMS. Il expire dans 10 minutes.</div>', 'info');
  } catch (err) {
    setError(err.message);
    resetOtpStep();
  } finally {
    submitBtn.disabled = false;
  }
}

async function submitSignup(payload) {
  const finalPayload = payload || pendingSignupPayload;
  if (!finalPayload) {
    setError('Les informations du formulaire ne sont plus disponibles. Demandez un nouveau code.');
    resetOtpStep();
    return;
  }

  const code = otpValue();
  if (!/^\d{6}$/.test(code)) {
    setError('Saisissez le code à 6 chiffres reçu par SMS.');
    const firstEmpty = otpBoxes.findIndex(box => !box.value);
    (otpBoxes[firstEmpty === -1 ? 0 : firstEmpty] || otpCode).focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Création en cours...';
  try {
    const response = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(otpPayload(finalPayload))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = data.errors ? data.errors.join('<br>') : (data.detail || data.error || 'Erreur inconnue');
      throw new Error(details);
    }
    signupCompleted = true;
    renderReceivedView();
  } catch (err) {
    setError(err.message);
  } finally {
    if (!signupCompleted) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Valider le code et créer mon compte';
    }
  }
}

function validatedPayload() {
  updateCompanyVisibility();
  const payload = formPayload();
  const errors = validateClient(payload);
  if (errors.length) {
    setError(errors.map(error => `<div>${error}</div>`).join(''));
    return null;
  }
  return payload;
}

async function submitForm(event) {
  event.preventDefault();
  setError('');
  if (previewMode) return;

  if (otpToken) {
    await submitSignup(pendingSignupPayload);
    return;
  }

  const payload = validatedPayload();
  if (!payload) return;
  await requestOtp(payload);
}

function renderReceivedView() {
  const formPanel = document.querySelector('.form-panel');
  if (!formPanel) return;
  formPanel.classList.add('is-received');
  formPanel.setAttribute('aria-labelledby', 'received-title');
  formPanel.innerHTML = `
    <a class="brand" href="https://www.sofy.fr/" rel="noreferrer">
      <img src="https://cdn.prod.website-files.com/692425aeab094a5d5da30bad/69242a559bca9c86f276f3a1_logo-SOFY.svg" alt="Sofy">
    </a>
    <section class="success-view" role="status" aria-live="polite">
      <div class="success-animation" aria-hidden="true">
        <span class="success-path"></span>
        <span class="success-signal signal-one"></span>
        <span class="success-signal signal-two"></span>
        <span class="success-step success-step-form">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5 9.4 17 19.2 7" />
          </svg>
          <strong>Formulaire</strong>
          <small>Rempli</small>
        </span>
        <span class="success-step success-step-review">
          <svg viewBox="0 0 24 24">
            <path d="M7 4.5h8l3 3v12H7z" />
            <path d="M15 4.5v3h3" />
            <path d="M10 12h5" />
            <path d="M10 15h4" />
          </svg>
          <strong>Vérification</strong>
          <small>En cours</small>
        </span>
        <span class="success-step success-step-enable">
          <svg viewBox="0 0 24 24">
            <path d="M12 3.5v6" />
            <path d="M8 7.5a6 6 0 1 0 8 0" />
          </svg>
          <strong>Activation</strong>
          <small>À venir</small>
        </span>
      </div>
      <p class="success-kicker">Étape terminée</p>
      <h1 id="received-title">Votre demande a bien été reçue.</h1>
      <p class="intro">Vous avez terminé votre inscription. Notre équipe vérifie maintenant vos informations et activera votre compte Sofy prochainement.</p>
      <div class="success-note">
        Vous recevrez un email dès que votre compte sera validé.
      </div>
    </section>
  `;
}

function createCombo(config) {
  const state = {
    ...config,
    filteredItems: config.items.slice(),
    selectedItem: null
  };

  renderComboOptions(state);

  state.trigger.addEventListener('click', () => {
    const opening = state.menu.hidden;
    closeAllCombos();
    if (opening) {
      state.root.classList.add('is-open');
      state.menu.hidden = false;
      state.search.value = '';
      state.filteredItems = state.items.slice();
      renderComboOptions(state);
      state.search.focus();
    }
  });

  state.search.addEventListener('input', () => {
    const query = state.search.value.trim().toLowerCase();
    state.filteredItems = query
      ? state.items.filter(item => item.search.includes(query))
      : state.items.slice();
    renderComboOptions(state);
  });

  return state;
}

function renderComboOptions(state) {
  state.options.innerHTML = state.filteredItems.map(item => `
    <button type="button" class="combo-option${state.selectedItem && state.selectedItem.code === item.code ? ' is-active' : ''}" data-code="${item.code}">
      <span class="combo-flag">${item.flag}</span>
      <span>${state.formatOption(item)}</span>
      <span class="combo-meta">${state.meta(item)}</span>
    </button>
  `).join('');

  state.options.querySelectorAll('.combo-option').forEach(button => {
    button.addEventListener('click', () => {
      const item = state.items.find(entry => entry.code === button.dataset.code);
      if (!item) return;
      selectComboItem(state, item);
      closeAllCombos();
    });
  });
}

function selectComboItem(state, item) {
  state.selectedItem = item;
  state.input.value = item.code;
  state.trigger.innerHTML = `
    <span class="combo-value">
      <span class="combo-flag">${item.flag}</span>
      <span class="combo-text">${state.formatTrigger(item)}</span>
    </span>
  `;

  if (state.input === countryCodeInput) {
    updateCompanyVisibility();
    if (!phoneCountryInput.value) {
      selectComboItem(phoneCombo, item);
    }
  }
}

function closeAllCombos() {
  document.querySelectorAll('.combo').forEach(root => root.classList.remove('is-open'));
  document.querySelectorAll('.combo-menu').forEach(menu => { menu.hidden = true; });
}

document.addEventListener('click', event => {
  if (!event.target.closest('.combo')) closeAllCombos();
});

companyName.addEventListener('input', searchCompany);
password.addEventListener('input', updatePasswordHelp);
form.addEventListener('input', event => {
  if (previewMode) return;
  if (!event.target.closest('.otp-field')) resetOtpStep();
});
otpCode.addEventListener('input', () => setOtpValue(otpCode.value));
otpBoxes.forEach((box, index) => {
  box.addEventListener('focus', () => box.select());
  box.addEventListener('input', () => {
    const digits = box.value.replace(/\D/g, '');
    if (digits.length > 1) {
      setOtpValue(otpValue().slice(0, index) + digits, Math.min(index + digits.length, 5));
      return;
    }
    box.value = digits;
    box.classList.toggle('is-filled', Boolean(digits));
    otpCode.value = otpValue();
    if (digits && otpBoxes[index + 1]) otpBoxes[index + 1].focus();
  });
  box.addEventListener('keydown', event => {
    if (event.key === 'Backspace' && !box.value && otpBoxes[index - 1]) {
      otpBoxes[index - 1].focus();
      otpBoxes[index - 1].value = '';
      otpBoxes[index - 1].classList.remove('is-filled');
      otpCode.value = otpValue();
      event.preventDefault();
    }
    if (event.key === 'ArrowLeft' && otpBoxes[index - 1]) {
      otpBoxes[index - 1].focus();
      event.preventDefault();
    }
    if (event.key === 'ArrowRight' && otpBoxes[index + 1]) {
      otpBoxes[index + 1].focus();
      event.preventDefault();
    }
  });
  box.addEventListener('paste', event => {
    event.preventDefault();
    setOtpValue(event.clipboardData.getData('text'), Math.min(index + 5, 5));
  });
});
resendOtpBtn.addEventListener('click', async () => {
  setError('');
  if (previewMode) {
    setError('<div>Mode aperçu : aucun SMS réel n’est envoyé.</div>', 'info');
    return;
  }
  if (pendingSignupPayload) {
    await requestOtp(pendingSignupPayload);
    return;
  }
  const payload = validatedPayload();
  if (payload) await requestOtp(payload);
});
togglePassword.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  togglePassword.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
});
form.addEventListener('submit', submitForm);

selectComboItem(countryCombo, byCode('FR'));
selectComboItem(phoneCombo, byCode('FR'));
updateCompanyVisibility();
applyPreviewState();

let activeModuleSlide = 0;
let moduleTimer = null;
const requestedModuleSlide = resolveRequestedModuleSlide();
const moduleSliderAutoplayPaused = requestedModuleSlide !== null;

function showModuleSlide(index) {
  if (!moduleSlides.length) return;
  activeModuleSlide = (index + moduleSlides.length) % moduleSlides.length;
  moduleSlides.forEach((slide, slideIndex) => {
    slide.classList.toggle('is-active', slideIndex === activeModuleSlide);
  });
  moduleButtons.forEach((button, buttonIndex) => {
    button.classList.toggle('is-active', buttonIndex === activeModuleSlide);
    button.setAttribute('aria-pressed', String(buttonIndex === activeModuleSlide));
  });
  updateModuleStory(activeModuleSlide);
}

function startModuleSlider() {
  if (
    !moduleSlides.length ||
    moduleSliderAutoplayPaused ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) return;
  stopModuleSlider();
  moduleTimer = window.setInterval(() => showModuleSlide(activeModuleSlide + 1), 5200);
}

function stopModuleSlider() {
  if (moduleTimer) window.clearInterval(moduleTimer);
  moduleTimer = null;
}

moduleButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    showModuleSlide(index);
    startModuleSlider();
  });
});

if (moduleSlider) {
  moduleSlider.addEventListener('mouseenter', stopModuleSlider);
  moduleSlider.addEventListener('mouseleave', startModuleSlider);
  moduleSlider.addEventListener('focusin', stopModuleSlider);
  moduleSlider.addEventListener('focusout', startModuleSlider);
}

if (moduleSlides.length) {
  showModuleSlide(requestedModuleSlide ?? 0);
  startModuleSlider();
}

if (isReceivedViewRequested()) {
  signupCompleted = true;
  renderReceivedView();
}

function applyPreviewState() {
  previewMode = requestedPreviewState();
  if (!previewMode || previewMode === 'received') return;
  fillPreviewForm();
  otpToken = 'preview-token';
  pendingSignupPayload = formPayload();
  showOtpStep();
  if (previewMode === 'otp-entered') {
    setOtpValue('123456', 5);
    setError('<div>Code saisi. Le prochain clic finalise la demande de création.</div>', 'info');
  } else {
    setError('<div>Code envoyé par SMS. Il expire dans 10 minutes.</div>', 'info');
  }
}

function fillPreviewForm() {
  const set = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.value = value;
  };
  set('[name="first_name"]', 'Camille');
  set('[name="last_name"]', 'Martin');
  set('[name="email"]', 'camille.martin@example.com');
  phoneInput.value = '06 12 34 56 78';
  companyName.value = 'Sofy Démo';
  set('#siret', '12345678900010');
  set('#tvaId', 'FR12345678901');
  set('#address', '1 rue de la Paix');
  set('#postalCode', '75002');
  set('#city', 'Paris');
  password.value = 'SofySignup!2026';
  document.querySelector('#cgv').checked = true;
  updatePasswordHelp();
}

function updateModuleStory(index) {
  const story = moduleStories[index];
  if (!story) return;
  if (storyTitle) storyTitle.textContent = story.title;
  if (storyDescription) storyDescription.textContent = story.description;
}

function resolveRequestedModuleSlide() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('module') || params.get('tab') || params.get('slide');
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isInteger(numeric)) {
    if (numeric >= 1 && numeric <= moduleSlides.length) return numeric - 1;
    if (numeric >= 0 && numeric < moduleSlides.length) return numeric;
  }

  const aliases = new Map([
    ['soview', 0],
    ['view', 0],
    ['google', 0],
    ['avis', 0],
    ['soreach', 1],
    ['reach', 1],
    ['sms', 1],
    ['rcs', 1],
    ['email', 1],
    ['soconnect', 2],
    ['connect', 2],
    ['messagerie', 2],
    ['conversationnel', 2],
    ['budyia', 3],
    ['budy', 3],
    ['ia', 3],
    ['ai', 3]
  ]);
  const key = normalizeModuleToken(raw);

  if (aliases.has(key)) return aliases.get(key);

  const slideIndex = moduleSlides.findIndex(slide => normalizeModuleToken(slide.dataset.module) === key);
  return slideIndex === -1 ? null : slideIndex;
}

function normalizeModuleToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isReceivedViewRequested() {
  if (requestedPreviewState() === 'received') return true;
  const params = new URLSearchParams(window.location.search);
  return ['received', 'success', 'submitted'].some(name => {
    const value = params.get(name);
    return value === '' || value === '1' || value === 'true';
  });
}

function requestedPreviewState() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('preview') || params.get('state') || params.get('step');
  const key = normalizeModuleToken(raw);
  const aliases = new Map([
    ['otpsent', 'otp-sent'],
    ['otp', 'otp-sent'],
    ['receivingotp', 'otp-sent'],
    ['codesent', 'otp-sent'],
    ['sms', 'otp-sent'],
    ['otpentered', 'otp-entered'],
    ['enteredotp', 'otp-entered'],
    ['codeentered', 'otp-entered'],
    ['final', 'otp-entered'],
    ['finalstep', 'otp-entered'],
    ['received', 'received'],
    ['success', 'received'],
    ['submitted', 'received']
  ]);
  return aliases.get(key) || '';
}
