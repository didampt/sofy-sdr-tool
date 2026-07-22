# HANDOFF — Reprise du travail (28 juin 2026)

> Passation depuis les sessions Claude.ai (Didier + Claude, ~23 sessions).
> Workflow : voir `AGENTS.md` (git pull au début, **validation Didier avant chaque commit+push**, push = déploiement Vercel).
> Didier : débutant en programmation → guidage **pas-à-pas, une étape à la fois, validation à chaque étape, réponses courtes en français**.

## Contexte express

- **Sofy Scrap** = outil SDR interne (listes de prospection, enrichissement, scoring, actions Ringover/Lemlist/HubSpot/Slack/SMS).
- **Prod : https://www.sofyscrap.com** — ⚠️ l'apex `sofyscrap.com` répond **308** vers www → **tout webhook externe doit viser `www.`** (Ringover et Snitcher corrigés ; Lemlist est enregistré sur `sofy-sdr-tool.vercel.app` et fonctionne — ne pas y toucher).
- Front = `public/index.html`, **VERSION courante = v253** (en prod, 22/07/2026). Monter `const VERSION='vNNN'` à chaque livraison front.
- Rôles : Didier=superadmin ; Romain (Head of Sales, à passer superadmin) ; SDRs : Alicia, Franck, Etienne, Sarah. Manon Bouly = coordinatrice AE (ne prospecte pas).
- IA serveur : **claude-sonnet-4-6 partout** (Opus non utilisable sur la clé).
- Interdit absolu : ne jamais mentionner **Apollo** ni **Vibe Prospecting**.
- Enrichissement = côté navigateur (l'onglet doit rester ouvert). BDD Neon Postgres via `api/db.js`. Vercel Pro (60 s).

## Fait récemment (26–28 juin)

1. **Rappels Slack** : cron `rappels-cron` passé à `* * * * *` dans `vercel.json` (les rappels partaient groupés/en retard à 30 min).
2. **Migration RB2B → Snitcher** : `api/snitcher.js` déployé + testé (Hot Lead + alerte Slack OK).
   - Segments Snitcher : « ICP Sofy — France/DOM » (visibilité seule) et « 🔥 Intent fort — page produit » (**seul segment branché au webhook**, pages `/so-connect`, `/so-reach`, `/so-view`).
   - URL webhook = `https://www.sofyscrap.com/api/snitcher?secret=<SNITCHER_WEBHOOK_SECRET>` (valeur dans Vercel).
   - RB2B tourne encore en parallèle → **à couper** après quelques jours de validation.
   - Une version de `snitcher.js` avec mode debug (`?debug=<secret>` + journal `snitcher_attempt`) existe mais **n'est pas déployée** (optionnelle).
3. **Appel entrant Ringover (screen-pop)** : `api/ringover-incoming.js` + bandeau front (v206). **Testé OK en prod.**
   - Webhook Ringover « Appels qui sonnent » → payload réel : `{resource:'call', event:'ringing', data:{from_number, to_number, call_id, user{...}, direction:'inbound'}}`.
   - Auth = JWT **HS512** signé avec `RINGOVER_WEBHOOK_SECRET` (en-tête `Authorization: Bearer <jwt>`), vérifié par `jwtValide()`. Accepte aussi `?secret=` (tests internes).
   - GET (token app) = polling 3 s par l'onglet SDR ; `?vu=<id>` ferme le bandeau ; fenêtre 45 s ; table `appels_entrants`.
   - Debug déployé : `GET /api/ringover-incoming?debug=<RINGOVER_WEBHOOK_SECRET>` → dernière tentative + derniers appels.
   - Match SDR par les 9 derniers chiffres de `sdrs.ringover_numero`.
4. **v207** : fix affichage source Snitcher — helper `estVisiteSite(e)` remplace 6 tests `source==='RB2B'` en dur (les fiches Snitcher affichent bien « visite sofy.fr »).
5. **v208** : bug « nom de liste tronqué » (Liste Intelligente) corrigé — champ **« Nom de la liste » obligatoire** dans la modale d'estimation IA (`ia-liste-nom`, mémo `window.IA_NOM_LISTE`), nom complet non tronqué (préfixe ✨ conservé).
6. Message Slack d'annonce équipe (Ringover + Snitcher) rédigé et remis à Didier.

## 🐛 BUGS EN COURS (priorité de reprise)

### Bug 2 — ✅ CORRIGÉ + TESTÉ EN PROD le 7 juillet 2026 (v210, commit b493d6e)
**⚠️ Le plan initial (v209, NAF → SIREN → postes) était INFAISABLE** : vérifié en prod, `people/find` par `siren` ne renvoie QUE les mandataires légaux (jamais les profils LinkedIn, même pour Stellantis). Filtres `naf_code`, `current_company_name`, `current_company_id`, headcount : tous ignorés sur people/find.
**Solution v210 (chemin `personne_secteur`)** : people/find par postes + macro-secteur, puis **tri sectoriel par claude-sonnet-4-6** (nom entreprise + site web, exclusion en cas de doute), pagination jusqu'à 6 pages / 600 profils (garde-fou 40 s). Estimation = taux sectoriel mesuré par IA sur 100 profils réels + échantillon.
**Découverte importante : la pagination Basile marche désormais** (abonnement actif, plus de 402) — testé 4 pages sans doublon. Et `companies/find` accepte le filtre `name:{include:[...]}`.
**Testé en prod (Claude, via l'onglet Chrome de Didier)** : estimation « dir. co automobile » = 2 981 bruts → taux 5 % → ~149 estimés, échantillon 100 % auto (4 s) ; génération = 20/20 fiches 100 % auto en 25 s ; modale v210 vérifiée visuellement. Reste : validation par Alicia en usage réel.

**Complément v211 (commit e413d7f, testé en prod)** : dédup par **LinkedIn** dans `api/dedup.js` (les fiches Basile n'ont ni email/tél/SIREN avant enrichissement → une régénération identique recréait les doublons et re-dépensait les crédits). Index `enrich.linkedin` des listes actives + normalisation d'URL ; le front (v211) envoie le LinkedIn à `/api/dedup`. Vérifié : contact existant re-soumis avec URL modifiée (casse+paramètre) → détecté.

### (référence) Bug 2 — le secteur est ignoré (Liste Intelligente, métropole)
**Symptôme** : Alicia demande « directeurs commerciaux secteur automobile » → elle reçoit des directeurs commerciaux de secteurs quelconques.
**Cause (diagnostic complet fait)** : Basile `people/find` ne filtre les personnes que par **7 macro-secteurs** (`SECTEURS_BASILE` dans `api/ia-liste-creer.js`) ; « automobile » → `commerce_global` = tout le commerce. Le **NAF précis** (`naf_codes` extraits par `api/ia-liste.js`) n'est utilisé que sur le **chemin DOM** « entreprise d'abord » (`companyFirst = domPrefixes.length>0 && !veutMetropole`). En métropole (personne d'abord), le secteur fin est perdu.
**Plan validé, à implémenter** — nouveau chemin hybride quand `veutMetropole && naf_codes présents` :
1. `companies/find` avec `{naf_code:{include:naf_codes}}` — **1 appel par code NAF, limit 100** (pas de pagination connue), post-filtrer les CP `97xxx` si métropole seule, exclure `sirenExclus` (SIREN déjà en base — mécanique existante).
2. `people/find` avec `{result_role:{include:rolesDepuisFamilles(criteres)}, siren:{include:<batchs de 30>}, result_is_current:true}` → fiches via `leadVersFichePersonne`, **enrichies avec `infoBySiren[siren]`** (nom officiel, ville, CP, NAF).
3. Mode `estimer` : renvoyer un nouveau `mode_recherche:'entreprise_postes'` → nb entreprises NAF + échantillon de **personnes** trouvées sur ~15 SIRENs (valide la chaîne) ; **adapter la modale front** (`ouvrirEstimationIA`) avec un wording dédié (ni « dirigeants légaux », ni « comptage personnes »).
4. Mode `creer` : cap SIRENs élevé (les postes ciblés sont plus rares que les mandataires ; ex. `max(cap*8, 240)` réparti sur les codes NAF), `regrouperParEntreprise`, slice au `capContacts`.
5. Prudence coût/durée : rester < 60 s (≈ 1 appel companies/find par NAF + 4–8 appels people/find).

### Bug 3 — ✅ CORRIGÉ le 7 juillet 2026 (v212, commit 8901eac) — Bouton « 👥 Personas »
**Cause confirmée = hypothèse (a)** : Alicia n'avait coché que « Dirigeant / PDG » à l'étape 5 → `jobsCibles()` vide → toast bloquant.
**Fix (option 2 validée par Didier)** : le clic ouvre maintenant une modale `personas-modal` (9 fonctions de l'étape 5, hors Dirigeant/PDG), mémorise le choix dans les critères de la liste (`PUT {id, jobs}` ajouté dans `api/listes.js`) puis lance la recherche. Modale vérifiée visuellement en prod (v213).
**À clarifier encore** : ~~où le nom des listes Pappers apparaît « tronqué »~~ → **ÉLUCIDÉ le 7 juillet** : les noms « auto-générés tronqués » sont d'anciennes listes **IA pré-v208** (prompt utilisé comme nom) ; le nom est déjà obligatoire sur les 3 flux (Pappers étape 6 + double garde, IA v208, manuelle). La confusion venait de l'étiquette « crédits Pappers » affichée pour toutes les listes (corrigé v215).

### Bug 5 — ✅ CORRIGÉ + TESTÉ EN PROD le 8 juillet 2026 (v217, commit 1aef927) — Recherche NAF du wizard Pappers : liste interne de 22 codes seulement
**Symptôme** : « cliniques esthétiques » (86.10Z / 86.22B / 86.22C) introuvable alors que Pappers connaît ces codes.
**Cause** : `searchNaf()` filtrait la `const NAF` locale (22 codes ICP historiques, aucun code santé) ; pas de saisie manuelle (`pickNaf` via clic uniquement ; `renderNafTags` faisait `NAF.find(...)[1]` → crash si code inconnu). Le serveur `api/liste.js` passe pourtant `code_naf` tel quel à Pappers → limite 100 % front.
**Fix (v217)** : nomenclature NAF rév. 2 complète embarquée (732 sous-classes INSEE, source SocialGouv/codes-naf, ~43 Ko) avec les 22 favoris ICP en tête ; recherche par préfixe de code (« 8622C », « 86.22 »…) ou par libellé ; saisie directe d'un code valide (`^\d{4}[A-Z]$` après normalisation, Entrée pour ajouter, proposé même si hors nomenclature) ; `renderNafTags` tolérant (code inconnu affiché seul, plus de crash).
**Cas de test validés** : taper « 8622C » et « clinique » sort des résultats.

### v219+v220 (commits 7eee6e9/a983a12, 8 juillet) — Liste Google Maps (ciblage SoView par note)
**Phase 1 validée par Didier** du plan « prospection SoView automatisée » (pivot : email pro + variables GMB plutôt que LinkedIn, cf. discussion — les fiches GMB n'ont pas de LinkedIn et les petits commerces y sont peu présents).
- `api/gmb-liste.js` (nouveau) : estimer (1 page Text Search/ville) + creer (3 pages/ville max = 60 étab., filtre note min/max, Place Details tél+site par 5). Max 5 villes, cap 100 fiches, conso `google_places` journalisée.
- Front : 4e mode « 📍 Liste Google Maps (SoView) » (activité, villes, note ≤ 4,0 par défaut, nb, nom obligatoire, SDR) ; étiquette historique + badge source + bandeau dédiés ; `remplirSelectSdr()` factorisé.
- v220 : `gmbHtml()` rendu tolérant (pire_fiche/avis_negatif optionnels — les fiches Liste GMB n'en ont pas) + `pire_fiche` auto (lien avis) côté serveur.
- **Testé en prod de bout en bout** : liste #61 « 📍 Test GMB garages Bordeaux (à archiver) » — 2 garages ≤ 4★ à Bordeaux avec tél+site (à archiver après inspection). ⚠️ Enseignement : « ≤ 4,0 ★ » est très sélectif (2/60 garages à Bordeaux) — conseiller ≤ 4,5 pour le volume.
- **Phase 2 livrée (v221, commit 9f9d8d6, testée en prod)** : Details récupère les avis → `gmb.avis_negatif` = le pire (< 4★), affiché sur la fiche ; extraction d'email générique depuis le site officiel (accueil, /contact, /mentions-legales — anti-SSRF, 3,5 s/page, budget 30 s) → contact « Accueil / Standard » prêt pour Lemlist ; toast avec compte d'emails. **Mesuré (10 garages Bordeaux ≤ 4,5★)** : 6/7 pires avis récupérés (1★ avec verbatims percutants), 5/7 emails (71 %).
- ⚠️ **Limite connue** : les franchises (AD, Speedy…) ont des sites du réseau national → email national partagé (ex. 3 fiches AD → `info@autodistribution.com`). Amélioration possible : dédoublonner/étiqueter les emails identiques dans une même création.
- **Phase 3 livrée (v222, commit 3993cc3, vérifiée en prod)** : bouton « ✈️ Envoi groupé Lemlist » sur les listes 📍 uniquement (masqué ailleurs — vérifié) ; éligibles = email + jamais envoyé + hors HubSpot/doublons ; confirmation batch avec décompte + alerte emails réseau ; envoi séquence **soview** avec les variables GMB de `varsLemlist` (gmb_note, avis_negatif, gmb_pire_fiche, gmb_concurrents — existaient déjà) ; 350 ms/envoi, arrêt propre au plafond. **Plafond serveur dans `api/lemlist.js`** : 50 nouveaux leads/SDR/24 h glissantes (env `LEMLIST_PLAFOND_JOUR`), les MAJ ne comptent pas, refus 429. **Dédup emails réseau** dans `gmb-liste.js` : email partagé gardé sur la 1re fiche + étiquette « ⚠️ email réseau national », les autres → À enrichir.
- **⚠️ Avant le 1er batch réel** : configurer la campagne `camp_soview` dans ⚙️ Envois ; faire le 1er envoi sur une PETITE liste (aucun envoi réel n'a été testé — j'ai vérifié uniquement bouton/éligibilité/confirmation). Vérifier que les templates Lemlist utilisent les variables {{gmb_note}} / {{avis_negatif}}.
- **v226 (commit d6d8580)** : bouton « 🔎 Emails manquants (IA) » étendu à **toutes les listes** (dernier recours sur Pappers/IA quand la cascade nominative n'a rien trouvé ; ne cible que les fiches sans aucun email) ; site transmis à l'IA via `domaineDe(e)`.
- **v227 (commit eed7135, testée en prod)** : fix WhatsApp — `waNumero()` ne convertissait PAS au format international (le commentaire l'annonçait, le code ne le faisait pas) → liens `wa.me/0690…` refusés par WhatsApp. Conversion réelle avec indicatifs DOM (Guadeloupe/St-Martin +590, Martinique +596, Guyane +594, Réunion/Mayotte +262, métropole +33), numéros déjà internationaux intacts. 15 cas testés + vérifié en prod (0690 80 91 33 → 590690809133).
- **v225 (commits cc687de/6dbcefe, testée en prod)** : **recherche web par IA des emails manquants**. Constat Basse-Terre : 14/20 restos sans site sur la fiche Google → 2 emails par scraping. Nouveau `api/email-web.js` : 1 fiche/appel, Claude + outil de recherche web Anthropic (actif sur la clé ✓, max 4 recherches, anti-hallucination : email uniquement s'il est VU, jamais déduit), JSON {site,email,telephone,source}, conso `ia_web_email` (~0,02-0,05 €/fiche). Bouton « 🔎 Emails manquants (IA) » sur les listes 📍, boucle navigateur avec progression. **Tests réels** : Del medio → site confirmé + mobile trouvé, email null honnête (formulaire seul sur le site) ; Wellington → null prudent (nom fiche ≠ nom site). Attente réaliste sur restos DOM : ~20-40 % d'emails (beaucoup n'ont QUE un formulaire/Instagram) — le téléphone reste le canal roi, et l'IA le trouve aussi.
- **v224 (commit 18b2c03, testée en prod)** : **multi-activités** (max 3, suggestions par fragment après virgule, plafond combinaisons activités × villes ≤ 6 front+serveur, profondeur 3/2/1 pages selon combos, quota réparti, dédup place_id inter-recherches, chaque fiche porte son activité) + **fix villes DOM** (Google classe les DOM sous GP/MQ/GF/RE/YT et limite 5 pays/requête → 2 requêtes autocomplete fusionnées). Vérifié : « fort-de-f » → Fort-de-France (Martinique), « mamoudzou » → Mamoudzou (Mayotte) ; estimation 2 activités × 2 villes (Bordeaux + Fort-de-France) = 36 établissements, échantillon mixte correct.
- **v223 (commit 675dbf4, testée en prod)** : champ activité = 33 catégories GMB officielles suggérées (datalist FR → `type` Google validé en liste blanche serveur → résultats limités à la catégorie exacte ; texte libre toujours possible sans type) ; champ villes = autocomplete Google villes FR (`?ville=` dans `places-autocomplete.js`, fragment après virgule, clic = ajout). Vérifié : « méri » → Mérignac…, estimation `car_repair` Bordeaux = 8 garages purs (vs pollution concessions en texte libre).

### v218 (commit 7cc1c70, 8 juillet) — Signaux : tri chronologique + alerte Slack 1/lead/24 h
**Question Didier** : « pourquoi Tonnellerie Radoux et Kiss The Bride restent en tête des Signaux ? » → `ordreFiches()` triait par date de réaction Lemlist uniquement : toute fiche avec une réaction (même vieille de 5 jours) passait devant les visites du jour.
**Fix** : `poidsEngagement()` = date du **dernier événement chaud toutes natures** (réaction Lemlist OU visite site OU signal LinkedIn). Vérifié en prod : visites du jour en tête, Radoux (email ouvert 08h34) 4e, Kiss The Bride (3 juil.) redescendu.
**Alerte Slack vérifiée** : le DM au SDR propriétaire existe (`alerterSdr` dans `lemlist-webhook.js`, via `activites.sequenceAdded` + `sdrs.slack_id`) et **a fonctionné le 6 juil. 12h33** pour Radoux→Etienne (1re ouverture). La règle « 1 seule alerte par type, à vie » est remplacée par **max 1 alerte/lead/24 h tous types confondus** (une ré-ouverture 2 jours plus tard re-déclenche).

### v216 (commit 2d3e05e, 8 juillet) — Liste intelligente : curseur, dédup serveur, 200 fiches
Suite au constat « 3 899 estimées mais 1 seule fiche » (liste 57 de Didier) : relancer les mêmes critères rebalayait les 600 mêmes profils Basile, quasi tous déjà extraits.
1. **Curseur de reprise persistant** : clé `ia_curseur_<hash des filtres>` en table `config` ; chaque génération reprend où la précédente s'est arrêtée (même le lendemain) ; repli page 1 si token Basile expiré ; `epuise:true` → message « fin du gisement » et rebalayage au run suivant.
2. **Dédup serveur** : les slugs LinkedIn déjà en base (listes actives) sont écartés AVANT le tri IA.
3. **Famille « direction » affinée** : Gérant/Gérante seulement quand d'autres familles sont demandées (sinon Président/PDG/DG noyaient la fenêtre : 78k → 27k profils bruts sur le cas auto).
4. **Cap 200** (souhait Alicia : 200 fiches/jour) : le front enchaîne jusqu'à 10 appels serveur/génération (~6 000 profils, 3-6 min, onglet ouvert), progression sur le bouton.
**Testé en prod** : lot 1 = 5 fiches 100 % nouvelles (500 profils), lot 2 sans curseur = reprise pages 6-10 depuis la base, 4 autres fiches. ⚠️ Curseur remis à zéro après les tests (les fiches de test n'ont pas été sauvées). **Rendement mesuré sur le segment auto étroit : ~1 fiche neuve/100 profils** (taux secteur 3 % × dédup) → ~822 contacts estimés au total sur ces critères ; pour tenir 200/jour, élargir régulièrement les critères.

### Autres livraisons du 7 juillet 2026
- **v214 (commit b16b02b)** : multi-sélection des tranches d'effectif à l'étape 3 Pappers (`effEnveloppe()` rétro-compatible, note si tranches non adjacentes — Pappers ne filtre que par fourchette continue, hash anti-doublon stable).
- **v215 (commit 8fd33ae)** : l'historique affiche la source réelle de chaque liste (🔥 automatique / 🤖 Liste intelligente + activité visée / ✍️ manuelle / 🏢 Pappers + NAF + zones + crédits) au lieu de « crédits Pappers » partout. Vérifié en prod.

### Bug 4 — ✅ CORRIGÉ le 7 juillet 2026 (v212+v213, commits 8901eac/2ba69c5) — badge source Snitcher
**Symptôme** : fiches Snitcher (Signaux) affichaient « 💼 source LinkedIn » au lieu de « 📍 source sofy.fr ».
**Causes** : (1) `sourceFiche()` testait encore `source==='RB2B'` en dur (oubli v207) ; (2) en corrigeant via `estVisiteSite()`, découvert que ce helper était trop gourmand (`indexOf('sofy')`) : les fiches « like post sofy » (signal LinkedIn) passaient pour des visites (badge + encart « Signal de visite » — bug latent depuis v207). `estVisiteSite` tranche désormais d'abord sur `signal.type` (`visite_site`→oui, `linkedin`→non, sinon repli source).
**Vérifié en prod sur les 38 fiches Hot Leads** : RB2B (26), Snitcher (4), Signup (1) → sofy.fr ; like post (6) → LinkedIn.

## Fait le 21-22 juillet 2026 (session personas/Lemlist/alertes/stats — v244-v245)

- **Personas = waterfall Basile d'abord (commit 1158caa)** : `api/personas.js` interroge Basile `/people/find` par filtre `employer` (exact `"X"` + contains si ≥5 car., construits depuis enseigne/nom/racine du domaine) avant l'agent Claude+recherche web (repli seul, plafond passé à 5). Vérif anti-faux-positifs du contains, classement cible/repli par mots-clés des postes, tarif `basile` 0,01 € ajouté dans `api/db.js`. **Découverte clé (test prod du 21/07)** : le filtre `employer` marche (salariés LinkedIn + dirigeants registre — cas Sheila Heng/MeilleurUtilitaire) ; `current_job_functions` ne marche PAS (« Marketing » → 0) ; les filtres inconnus sont ignorés silencieusement. Doc : https://docs.basile.cc/openapi.yaml — **Validé en prod** (MeilleurUtilitaire : Manon + Karl ajoutés). ⚠️ Karl (Technico-Commercial) est sorti « cible » via le mot-clé « commercial » — resserrage possible (exclure technico/chargé de/conseiller), non arbitré.
- **Lemlist enrichissement (commits 73487ff + 16f6883)** : `api/lemlist-enrich.js` — parsing tél/email élargi (balayage récursif, un mobile FR trouvé n'importe où prime sur un fixe du champ principal) + `brut` si rien d'extrait et GET `?brut=1` (relecture diagnostic gratuite). **Cas P. Cambril élucidé** : pas un bug — le fixe a été trouvé par Lemlist APRÈS le passage Sales Nav d'Etienne (l'API renvoie ensuite le résultat en cache instantanément) ; personne n'a jamais trouvé de mobile pour lui.
- **v244 (commit ebda639)** : bouton **👯 Lookalike** sur chaque fiche (ouvre la Liste intelligente préremplie : nom, activité, NAF exact, effectif, zone DOM/métropole — curseur sur « Postes recherchés : ») + **reprise auto des enrichissements Lemlist en attente** à l'ouverture d'une liste (`reprendreLemlistEnAttente()`, relecture gratuite, toast si contacts complétés).
- **Alertes Slack Lemlist enrichies (commits 2f23dfa + eebcdf2)** : `lemlist-webhook.js` — le DM au SDR contient désormais le **numéro à appeler** (mobile FR > fixe contact > standard GMB via `localiserLead()`) et un **lien profond** `?liste=<id>&fiche=<clé cleSignal>` qui ouvre et surligne la fiche ; chaque alerte est **journalisée au bloc-notes** (type `alerte_slack`, hors liste ALERTE donc sans effet sur la règle 1/24 h) ; `warmed` (réponse générique) ajouté aux types alertants.
- **v245 (commit 8af3546)** : **garde-fou archivage** — une liste ne s'archive que traitée à 100 % (`pct_tag`, issues d'appel ; fiches exclues hors dénominateur). Front : modale SDR → « Passer en nurturing » ; admin → « Archiver quand même » (`forcer:true`). Serveur : PUT archivee → 403 `non_terminee` sinon (le cron d'auto-archivage nurturing passe en SQL direct, non concerné). + **panneau « Stats » par liste** (bouton sur chaque carte, Historique + Archives, visible par tous) : `GET /api/listes?stats_detail=<id>` calcule à la demande tuiles (traitement, RDV + date du 1er + coût/RDV, réponses, coût/fiche), entonnoir (fiches→enrichies→email→Lemlist→ouvertures→réponses→RDV via `activites`), activité SDR (WhatsApp/SMS/rappels/notes/alertes), rythme (jours actifs, fiches/jour), barre des issues d'appel. NB : les appels téléphoniques ne sont PAS journalisés en tant qu'activités (seuls WhatsApp/SMS/RDV/notes le sont) — le panneau affiche « fiches statuées », pas un compteur d'appels.

## Fait le 22 juillet 2026 — Cockpit & signaux (v246-v253)

Feuille de route arbitrée avec Didier (inspirée des pratiques SDR B2B SaaS US + Pharow) : 1) Cockpit du jour ✅ 2) séquences par température (À FAIRE — backlog #4) 3) détection techno concurrente ✅ 4) veille note GMB ✅ 5) objections IA hebdo (idée) 6) recyclage job-changes (idée).

- **v246-v248 — Cockpit « Ma journée »** (commits 225242f, b0ae04b, c047943) : `api/cockpit.js` (1 requête agrégée) + l'onglet remplace « Tâches » (badge = rappels en retard). 3 étages : signaux chauds 24 h (activites ALERTE, masqués si fiche re-statuée depuis) → rappels dus → fiches sans issue d'appel triées par score (top 25). **Panneau dépliable par ligne** : accroche + synthèse d'appel, tous les contacts (📞 tel:, 🟢 WA + 💬 SMS direct sur mobiles, journalisés via /api/activite), standard GMB, « Ouvrir la fiche complète » (SMS SoReach & co). **Statuer… inline** = PUT chirurgical `{id, fiche_cle, statut_appel}` dans api/listes.js (traite_par/traite_le + recalcul stats, sans recharger la liste). « Vue SDR » (admin) = cockpit de n'importe qui.
- **v249 — KPI & objectifs** (commit 1e27bbb) : tuiles du jour (appels sortants/décrochés/durée moy. **Ringover réels**, chargés en différé via `?appels=1` ; statuées ; RDV X/objectif mois) ; `sdrs.objectif_appels_jour` + `objectif_rdv_mois` (défauts 50/j, 20/mois — benchmarks B2B SaaS), éditables dans Paramètres ; barre = objectif d'appels (décrochés/sans réponse) ; **bannière fin de gisement** (< 50 fiches, prévision au rythme 7 j, rouge à 0) avec boutons « Créer une liste » + « 👯 Lookalike de mon dernier RDV » (`creerLookalikeDepuis(CK.lookalike_ref)`).
- **v250 — Détection techno concurrente** (commit 48618e1) : `api/techno.js` (gratuit, 1 fetch accueil, anti-SSRF) — 21 signatures : outils d'avis (Partoo, Guest Suite, Avis Vérifiés/Skeepers, Trustpilot, Custeed, Opinion System… = concurrents Soview), chat (Crisp, Tawk, Intercom, WhatsApp… = angle SoConnect), marketing (Brevo, Mailchimp, HubSpot). Pipeline étape 2 bis ; badges ⚔️/🟢/💬/📣 ; règles d'angle « switch élégant / terrain vierge / SoConnect » dans score.js + email-angle.js via `technos_detectees`. ⚠️ Les fiches déjà enrichies n'ont le badge qu'au prochain 🚀.
- **v251 — fix Paramètres** (commit 1f15197) : ⚠️ PIÈGE — le tableau SDRs a DEUX en-têtes (un statique ligne ~1071, écrasé par celui généré dans `chargerSdrs()`) ; l'édit v249 avait modifié le mauvais → colonnes décalées.
- **v252 — Veille e-réputation GMB** (commit fe01893) : `api/veille-gmb.js`, cron quotidien 03:00 — re-lit la note (Place Details rating, ~0,005 $) des fiches des listes **veille/nurturing**, ~1×/mois/fiche, plafond 40/jour, conso sous 'veille-gmb'. Déclencheurs : −0,2★ / nouveaux avis qui font baisser / passage sous 4,0★. Actions : DM Slack au SDR (avant→après + lien profond), `e.signal_gmb` (badge 📉 45 j), trace bloc-notes, e.gmb rafraîchi, `alerte_note_google` au scoring.
- **v253 — Journal automatique des journées** (commit 8fc606e) : table `journees_sdr` + `api/journee-cron.js` (cron 17:00 UTC lun-ven ≈ 19 h Paris) — journée dérivée des actions réelles (Ringover : début/fin/appels/décrochés/durée ; traite_le : statuées ; bloc-notes : RDV), **aucun pointage manuel** (choix explicite de Didier contre un bouton démarrer/clôturer). DM Slack de bilan du soir (+comparaison moy. 7 j, record semaine). Cockpit : deltas ▲/▼ vs moy. 7 j sur Appels/Décrochés/Statuées (s'allument dès 1 jour d'historique).
- Divers : `warmed` ajouté aux types d'alerte Slack Lemlist (eebcdf2) ; personas — exclusion des technico-commerciaux (31bf2b3).

## Backlog (ordre Didier)

1. **Tableau croisé dynamique pour Romain** (liste × SDR × statut × coût + exports) — en attente de l'arrivée de Romain.
1bis. ~~Liste « lookalike » depuis une fiche~~ → **LIVRÉ en v244** (bouton 👯 Lookalike, voir « Fait le 21-22 juillet »).
2. Couper RB2B une fois Snitcher validé sur de vraies alertes (vérifier le mapping réel via `config('snitcher_last')`).
3. Domaine : passer proprement en www principal (`APP_URL=https://www.sofyscrap.com` + Redeploy), puis ré-enregistrer le hook Lemlist.
4. [Projet séparé] Lemlist : transfert auto des leads non joints → séquences par produit + température.
5. Fix `ringover-record` : la regex anti-SSRF n'autorise que `cdn.ringover.com/records/` → 400 sur les URLs `/messages/`.
6. Re-tagging IA des transcriptions Ringover (17 statuts d'appel).
7. SoReach SMS + WhatsApp dans le dashboard ; pagination des fiches.

Admin (côté Didier, à relancer) : Romain → superadmin ; lignes Ringover de chaque SDR dans Paramètres ; liens RDV des AE ; supprimer du repo `basile-debug*`, `basile-geo`, `basile-secteur` ; déployer (optionnel) le `snitcher.js` avec debug.

## Pièges connus (ne pas se refaire avoir)

- **Webhooks externes → toujours `www.sofyscrap.com`** (l'apex 308 avale les POST).
- Ringover ne pousse **rien** vers une URL non « Verified » ; son payload réel ≠ doc (voir plus haut) ; la clé sert à **signer** (JWT HS512), elle n'arrive jamais en clair.
- Basile : pas de filtre région/département ni effectif sur `people/find` ; 7 macro-slugs `*_global` seulement ; `FAMILLES_POSTE` figées côté serveur (déterminisme) ; géo fine uniquement via `companies/find` (codes postaux / NAF).
- CSP stricte : **aucune lib externe** dans `public/index.html` (script-src 'self' 'unsafe-inline').
- `listes.entreprises` (JSONB) = source de vérité ; préserver sa forme.
- Secrets : valeurs dans **Vercel → Environment Variables** (27 vars ; `RINGOVER_WEBHOOK_SECRET`, `SNITCHER_WEBHOOK_SECRET`, etc.). Ne jamais les exposer côté client ni les committer.
- Les fiches Hot Lead Snitcher niveau entreprise n'ont pas de personne nommée → les contacts proposés viennent de LinkedIn (personas) : **normal**.
