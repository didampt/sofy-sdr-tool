# HANDOFF — Reprise du travail (dernière mise à jour : 26 août 2026)

## 🎯 26 août 2026 — Audit v2 (planche GEO/IA), PDF fidèle, bug Franck (5 commits : de89829 → be30083)

### 1. Bug Franck : « 145 trouvées » → 2 livrées — les doublons sont désormais REMPLACÉS (`de89829`)
Pappers renvoie toujours les résultats dans le même ordre → les fiches déjà extraites forment un
**PRÉFIXE** des résultats. L'ancienne génération les soustrayait de la page rapatriée : relancer des
critères proches livrait 0-2 fiches. Désormais `api/liste.js` filtre les SIREN connus **avant** la
pagination et balaie jusqu'à **10 pages** pour réunir le nombre demandé de fiches fraîches.
`api/estimer.js` applique les mêmes règles que la génération (nb_etab_min, cascade effectif,
dédoublonnage mesuré sur la vraie 1ʳᵉ page) et renvoie une **fourchette** `[nb_genere_min,
nb_genere_max]` — jamais d'extrapolation de taux : le préfixe rend un taux linéaire faux dans le
cas le plus courant. Front : modale d'estimation détaillée, bandeau d'exclusions permanent sur
l'écran de résultats, message de liste vide qui nomme la vraie cause.
⚠️ Piège testé : le bloc pagination a été validé par simulation VERBATIM (extraction du bloc +
`call` factice, 9 scénarios) — refaire pareil à toute modification, il n'y a pas de tests.

### 2. PDF de l'analyse : une planche = une page, identique au web (`b1df990`)
Trois causes reproduites en local avant correction : (a) les chiffres en dégradé-texte
(`background-clip:text`) disparaissent quand l'impression supprime les fonds, les ombres sortent
en pavés gris ; (b) courbes/barres/donuts/cascades n'existent qu'à l'état `.on` posé par
l'animation au défilement ; (c) le viewport d'impression (794 px < 900) fait tomber les media
queries desktop → colonne unique interminable.
**⚠️ SOURCE UNIQUE À MAINTENIR : `REGLES_IMPRESSION` dans `api/p.js`** — partagée entre la feuille
`@media print` et la mesure JS qui calcule le zoom par planche (`--pz`). Toute évolution du
responsive (media queries min-width, clamps vw) DOIT s'y répercuter, sinon le PDF re-divergera.
Banc de test : Chrome headless `--print-to-pdf` + rendu PDFKit page par page (scripts dans le
scratchpad de session, refaisables en 5 min — cf. commit pour la méthode).

### 3. Audit v2 : planche GEO/aperçu IA + angles omnicanal et RCS (`d2d07f4`, `c0b1b87`, `be30083`)
Wireframe validé par Didier le 26/08 (artifact « Wireframe Audit v2 »), puis 3 générations réelles
sur BigMat Latronquière pour vérifier. Le document passe à **13 planches**.
- **Planche 05 `geo_ia`** (`plancheGeoIa()` dans `api/prez.js`) : calculée comme la trajectoire,
  jamais rédigée. Titre adaptatif selon `ia_visibilite` (cité / pas cité / pas d'aperçu). Courbe
  « score d'audit de votre visibilité locale /100 » = l'arithmétique du `scorer()` rejouée avec
  les seuls critères que des ACTIONS contrôlent (fiche complétée à 3 mois, avis répondus à 6,
  volume au plancher Groupe Kiosque à 12). Jamais la note ni la position. Un jalon sans
  progression ne s'affiche pas ; pente < 5 points → pas de courbe ; aucune mesure → pas de planche.
  La courbe PEUT atteindre 100/100 (petite fiche, tous critères couverts par les actions) —
  signalé à Didier, assumé : c'est l'arithmétique exacte, le contrat d'honnêteté est affiché.
- **Consignes duels** : SoConnect = commerce conversationnel OMNICANAL (46 % vs 42 % Ipsos-BVA
  2025 ; WhatsApp 1ʳᵉ messagerie de France SANS avoir remplacé tél/e-mail) ; SoReach =
  démonstration du RCS (identité vérifiée anti-spam, carrousels, vidéos, conversation) +
  « **Google Partner RBM** » mot pour mot (formulation validée Didier, ne pas reformuler).
  Les duels ont interdiction de refaire un duel entier sur l'aperçu IA (la planche 05 existe).
- **Pièges vus sur les générations réelles** : le relevé range parfois « Google » parmi les
  entités citées par l'aperçu IA → filtré dans `plancheGeoIa` (artefact de mesure, pas un
  concurrent) ; la phrase se reformule quand la liste filtrée est vide (tiret orphelin sinon).

### 4. Base de connaissance `kb_sales` — DEUX pièges corrigés (`d2d07f4`)
- **Le module « tous » (le DÉFAUT de génération) ne voyait que les blocs rangés en « tous »** :
  l'essentiel de la base était exclu du prompt. Corrigé dans `blocsUtilisables()`.
- **Tout ajout au `SEED` exige un `POST /api/kb-sales {seed:true}` manuel (admin) après
  déploiement** — l'auto-amorçage ne joue que sur base VIDE. Constaté : 6 blocs ajoutés au code
  les 19-21/08 (cas Marimax, Groupe Kiosque, mécanismes) n'avaient JAMAIS atteint la prod.
  Relancé le 26/08 : 12 ajoutés, 12 revalidés, 24/24. Vérifier `total` = `grep -c "cle_seed:"
  api/kb-sales.js` après chaque relance.
- 6 nouveaux blocs sourcés : aperçus IA France 22/07/2026 + 43 % US (Semrush), WhatsApp France
  32 M (Médiamétrie), conversationnel 46 % vs 42 % (Ipsos-BVA 2025, fourni par Didier),
  puissance RCS, Google Partner RBM, commerce omnicanal. Chiffres externes validés Didier 26/08.

### 5. Planche « Pourquoi Sofy » + couverture v2 (soir du 26/08 — rendu, zéro régénération)
Tout est injecté AU RENDU dans `api/p.js` (comme la trame instit) : les documents déjà générés
en bénéficient, une correction de texte se déploie d'un push.
- **Planche 12/13 « Pourquoi Sofy »** (statique) : carte coach incarnée (Cloé, photo public/),
  photos SunSMS/Optima Group, carte application mobile (9 fonctionnalités, note 4,9 ★ EN DUR — à
  rafraîchir à la main), habilitations (Google Partner · Partner RBM · ARCEP · agrégateur direct),
  4 chiffres, bandeau clients défilant (lu de `kb_visuels` type client).
- **Couverture v2** : encart SDR retiré, accroche fixe, 3 tuiles teaser CALCULÉES depuis les
  mesures (`couvertureV2()` — si < 2 mesures, couverture d'origine), méthodo en petit, méta
  (nb planches, date des relevés, jours de validité — lus de la ligne prez).
- **CTA** : portrait du SDR à la place de la photo d'équipe (filet : photo d'équipe) ; le bandeau
  de logos y a été RETIRÉ (déménagé sur la planche 12).
- `visuelsInstit()` rapporte aussi : `apps` (le visuel « application mobile » le plus récent —
  le déposer DÉTOURÉ en PNG, un fond opaque jure sur le violet) et `symbole` (« symbole »).
- ⚠️ Pièges du jour : `public/logo-icon.png` est ROGNÉ à gauche et `logo-full.png` n'a PAS de
  symbole — le seul export propre est `public/logo-symbole.png` (copié de sofy-emoji-symbole-256).
  Un item de grid contenant le bandeau défilant doit porter `min-width:0` (sinon la piste
  max-content déborde et crée des pages PDF fantômes). En print, les planches réduites se
  centrent via `.pl{margin:auto}`. La passe de contrôle = planche-contact des 13 pages, TOUTES.

### 6. Visuels de la planche app : la chaîne de dépôt préserve enfin les PNG (`c6426b9`, `71df02b`)
Le premier dépôt réel a révélé que `compresserImage()` (public/index.html) convertissait TOUT en
JPEG : un visuel détouré devenait un pavé blanc sur la carte violette. Corrigé en trois verrous :
- **le dépôt garde le format PNG** quand le fichier source est un PNG (transparence préservée ;
  le recadrage portrait des couvertures aplatit toujours, exprès) ;
- **la planche ne prend le visuel app de la base que s'il est PNG** (`data:image/png`), sinon
  filet `public/pourquoi-app.png` (le téléphone détouré, versionné). Le symbole a le même filet
  (`public/logo-symbole.png` — copie de `sofy-emoji-symbole-256.png`, la SEULE source propre :
  `logo-icon.png` est rogné à gauche, `logo-full.png` n'a pas de symbole) ;
- **12 étapes de réduction au lieu de 6** (les exports Illustrator 2000px+ déclenchaient
  « vignette trop lourde ») + dernier recours JPEG plutôt qu'un refus.
⚠️ Piège utilisateur : un onglet Sofy Scrap ouvert AVANT un déploiement garde l'ancien front —
Didier a redéposé son PNG à travers l'ancienne conversion JPEG. Après un push qui touche
public/index.html, recharger l'onglet avant tout dépôt.
La note « 4,9 ★★★★★ » de la carte app est EN DUR dans `api/p.js` (`.pq-note`) — à rafraîchir à la
main quand la note du store bouge.

### Reste à faire / à surveiller
- **Visuel app en base : encore le JPEG** (redéposé via l'ancien front) → le filet s'affiche, le
  rendu est correct. Pour que la base reprenne la main : recharger l'onglet, redéposer
  `sofy app (2).png` (description « visuel application mobile sofy »).
- Le visuel « symbole » n'existe pas en base (fallback actif, identique visuellement) — dépôt
  optionnel, description contenant « symbole ».
- Didier doit supprimer les liens de test BigMat (`LHwow010mFq4`, `YzZAZ1hPcaDX`) — le bon
  document est `fNYkkfv0evc8`.
- Safari réel jamais testé pour le PDF (banc = Chrome headless) : au premier export Safari d'un
  SDR, vérifier ; les en-têtes date/URL restent un réglage utilisateur sous Safari.
- L'estimation Pappers chiffre désormais le coût sur les fiches réellement livrées : une relance
  des mêmes critères dépense le prix d'une vraie liste (25 détails) là où l'ancien comportement
  n'en facturait que 2 — c'est voulu, l'estimation l'annonce avant de dépenser.

## 🛑 21 août 2026 — « Ne jamais affirmer ce qu'on n'a pas mesuré » (v395 → v403)

> **À lire avant de toucher à `api/prez.js`, `api/techno.js` ou `api/fiche-audit.js`.**
> Didier a généré l'audit sur **notre propre fiche Google** et y a relevé **sept affirmations
> fausses**, puis trois autres au fil des corrections. Ce n'était pas dix bugs : c'était **une seule
> faute, répétée** — le code affirmait une ABSENCE là où il n'avait rien réussi à DÉTECTER.
> Ce document sort de l'entreprise. Une affirmation fausse sur la fiche du prospect détruit
> exactement ce qui fait sa valeur : le fait que tout y soit vérifiable devant lui.

### Les trois règles qui en sortent

**RÈGLE 1 — Un critère ne peut valoir « faible » que sur une absence CONSTATÉE.**
Sinon il vaut `inconnu`, il est noté **sur 0** (donc exclu du score : ni pénalité, ni cadeau) et son
libellé dit ce qui n'a pas pu être vérifié. Un chiffre absent ne se remplace jamais par un zéro.
Corollaire livré au prompt (règles **1 bis** et **1 ter**) : un champ nul ou marqué
« NON MESURABLE » n'autorise aucune affirmation de manque, et le champ « ce que ça coûte » ne peut
affirmer que ce que la mesure établit.

**RÈGLE 2 — Un axe trop peu mesuré ne se note pas.**
En excluant l'invérifiable, « Communication mobile » n'a plus gardé qu'un critère et affichait
**100/100 solide** — le miroir exact du défaut corrigé, et la fin de l'angle SoReach. Un axe n'est
noté que si **≥ 2 critères** sont mesurés ET couvrent **≥ 40 %** de ses points. Sinon « non évalué »,
avec la raison écrite — ce qui est précisément ce qui justifie le rendez-vous.

**RÈGLE 3 — Une correction qui n'atteint pas les données existantes n'est pas une correction.**
Le piège le plus coûteux de la session, tombé **trois fois** :
* le cache `fiche_audit` dure 30 jours et `SELECT *` rend la ligne telle quelle → colonne
  `revision` ; les lignes < 2 voient `photos_enseigne` et `description_presente` neutralisées à la
  lecture. **La révision voyage AUSSI dans l'objet rendu**, car une copie périmée reste stockée sur
  la fiche des semaines sans que rien ne la rafraîchisse ;
* `technos_fait = true` faisait sauter le scan du site → `REVISION` dans `api/techno.js` +
  `TECHNO_REV` côté front + helper unique `technosAFaire(e)`. **Les deux constantes doivent rester
  synchronisées à chaque évolution des signatures** ;
* une requête locale erronée (« Paris ») stockée dans l'audit était relue en priorité par
  `requeteLocale()` → l'erreur s'auto-entretenait pendant 30 jours. Une valeur qu'on a nous-mêmes
  écrite par erreur ne fait pas autorité : `requeteValable(q, ville)` la refuse.

### Ce qui N'EST PAS mesurable de l'extérieur — ne pas réessayer

| Sujet | Pourquoi c'est impossible |
|---|---|
| **Bouton WhatsApp d'une fiche Google** | Le bouton existe (prouvé capture en main). Le diagnostic `?champs=1` a rendu les **34 clés** de la fiche telle que SerpApi la voit : aucune ne le porte. → bouton **« ✋ Je le vois sur la fiche »**, constat SDR daté et signé, et le document dit d'où il vient. |
| **Soview / SoReach chez un client** | Pilotés depuis `app.sofy.fr`, ils ne déposent **rien** sur le site du client. Aucune signature n'existe. → le statut client vient de **HubSpot** (`estClientHubspot`, lifecyclestage). |
| **Toute plateforme d'envoi SMS** | Les envois partent d'un tableau de bord, jamais du navigateur du visiteur. |
| **Description du propriétaire d'une fiche** | SerpApi ne l'expose pas de façon fiable (elle existe sur SOFY France, il ne l'a pas rendue). Tri-état `true` / `null`, **jamais `false`**. |
| **Attribution des photos d'une fiche** | Le filtre cherchait `p.source`/`p.author`, champs que SerpApi ne rend pas → `0` sur **toutes** les fiches du monde. `photos_enseigne` vaut `null` quand on ne sait pas. |
| **Ce qu'il y a DERRIÈRE un canal** | Un outil, un process, une personne : rien de tout ça n'est visible. C'est ce qui a produit « sans historique partagé, sans transfert entre collègues » servi à un client SoConnect. |

### Détection d'outils sur un site : trois natures de preuve

`api/techno.js` — `urlsDuDocument()` rend `{charge, liens, marqueurs}` :

1. **ressource chargée** (`script src`, `iframe src`, `link href`, `data-*`) → l'outil **tourne** ;
2. **conteneur déclaré** (`id="sofy-chat-widget"`) → l'outil est **installé** ;
3. **lien cliquable** (`<a href>`) → de la **navigation**, ça ne prouve rien —
   **SAUF** pour un canal de contact : un bouton WhatsApp EST un `<a href="wa.me/…">`, il n'y a pas
   d'autre façon de le poser. Ces signatures portent `parLien: true`.

Deux faux positifs successifs, tous deux sur notre propre site :
* un motif cherché dans **tout le HTML** → « Guest Suite détecté » parce que sofy.fr le nomme dans
  ses pages comparatives ;
* puis `href` capturé **sans distinction** → même verdict, cette fois à cause d'un **lien vers un
  article de blog** de Guest Suite cité en source.
Et l'inverse : une page de **documentation** qui montre un snippet l'a échappé (`&lt;div id=…`),
elle ne produit donc aucun faux positif — vérifié explicitement.

**Signature Sofy confirmée** (fournie par Didier — les précédentes étaient **inventées** et ne
détectaient rien) :
```html
<div id="sofy-chat-widget" data-id="01K…">
  <script src="https://webchat-next.sofy.fr/plugin.js"></script>
</div>
```
→ `motifs: ['webchat-next.sofy.fr','webchat.sofy.fr','sofy.fr/plugin.js']`,
`balises: ['sofy-chat-widget']`. **Ne pas y remettre de motif supposé.**

Les critères chat / avis / SMS reposent désormais sur la **catégorie** portée par la signature, plus
sur une liste de noms d'éditeurs codée en dur — notre propre webchat n'y figurait pas, et un client
SoConnect lisait « aucune messagerie web détectée ».

### 🆕 Mode EXPANSION (décision Didier : option b)

`m.mode` vaut `'expansion'` dès qu'un outil Sofy est détecté **ou** que le CRM confirme le statut
client. Mêmes mesures, **autre nature de document** :
* cadrage dédié dans le prompt : chaque planche part de **ce qui est en place** et pointe ce qui ne
  l'est pas encore ; interdiction de proposer de « mettre en place » une brique qu'il utilise ;
  quand on ne sait pas si une brique est branchée sur un canal, **on le demande** ;
* bandeau **« LEVIER n SUR m »** au lieu de « PROBLÈME n SUR m » ;
* champ **« Ce qui reste à gagner »** au lieu de « Ce que ça coûte » ;
* et en amont, une alerte **avant le choix du module** dans `genererPrez()` — sur un refus, zéro
  appel réseau.

⚠️ **HubSpot dit « client », PAS « a SoConnect ».** Trois états à distinguer, jamais deux :
boîte unifiée **constatée** (on la nomme) · client au **module inconnu** (on demande) ·
**prospect** (le canal est mesuré, ce qu'il y a derrière se demande). J'ai failli livrer
« vous disposez déjà d'une boîte de réception unifiée » à un client Soview seul.

### Deux bugs de plomberie à connaître

* **`a2.bouton_whatsapp_actif` valait toujours `undefined`** : `a2` est l'audit BRUT, le champ est
  calculé sur `m.google.audit_fiche`. Ce défaut n'était jamais sorti depuis son écriture. La phrase
  que Didier a lue venait en réalité d'une **instruction du prompt** qui la dictait mot pour mot.
* **`ckAnalyse()` avait son propre contrôle pré-vol**, qui renvoyait le SDR lancer « ↻ Analyser » à
  la main — alors que `genererPrez()` proposait deux secondes plus tard de tout lancer seul. Deux
  fenêtres, conseils opposés. Un seul endroit décide : `genererPrez()`.
* **Un bouton qui ne peut pas agir ne doit pas être affiché.** Depuis « Ma journée », `relevesHtml`
  est appelé avec `i = -1` : le bouton « ✋ Je le vois » s'affichait et `REAL[-1]` sortait par un
  `return` **muet**. → `relevesHtml(e, i, compact, rid)`, et `ckDeclarerWhatsapp(rid)` pour ce
  chemin. `api/cockpit.js` transporte `whatsapp_declare` et le drapeau `nous`.

### Où retrouver quoi

| Version | Ce qui a été corrigé |
|---|---|
| **v395** | La règle : plus de « faible » sans absence constatée. Les 7 affirmations fausses. `revision` de `fiche_audit`. Intégration vs mention textuelle. Axe non noté faute de mesures. |
| **v396** | La requête « Paris » qui s'auto-entretenait dans le cache · catégorie Google cherchée AVANT ce qui en dépend · neutralisation des champs périmés à la lecture du cache. |
| **v397** | Les deux dialogues contradictoires avant l'audit (`ckAnalyse` vs `genererPrez`) · scan des outils du site ajouté au pré-audit (gratuit). |
| **v398** | Le lien sortant compté comme outil installé · `parLien` pour les canaux de contact · bouton « ✋ Je le vois sur la fiche ». |
| **v399** | Signature réelle du webchat SoConnect (les précédentes étaient inventées) · détection par conteneur · critères par catégorie et non par nom d'éditeur · `deja_equipe_sofy`. |
| **v400** | Vérification que le webchat installé sur sofy.fr est bien détecté · doublon de badge. |
| **v401** | Statut client lu dans **HubSpot** au lieu d'être deviné · alerte avant dépense · critère « outil d'avis » adossé au taux de réponse observable. |
| **v402** | `REVISION` / `TECHNO_REV` : le scan repart quand les signatures changent · le bouton « ✋ » fonctionne enfin depuis Ma journée (plus de `return` muet). |
| **v403** | Mode **expansion** · la phrase « rien derrière votre WhatsApp » (dictée par le prompt, et morte dans le code) · règle 1 ter sur le champ « ce que ça coûte ». |

### Reste à faire sur ce sujet

1. **URL d'embarquement du widget Soview** — n'existe probablement pas (piloté depuis
   `app.sofy.fr`). Si une propriété HubSpot listait les **modules souscrits**, elle serait lue dans
   le même appel et le badge « ❔ Soview : à vérifier avec lui » deviendrait une vraie mesure.
2. **Argument « aucune description » perdu volontairement.** Rétablissable si un diagnostic montre
   que SerpApi la rend habituellement — mais **ne pas le supposer**.
3. Relire les libellés du scorer avec Didier : ils portent l'argumentaire commercial, et deux
   d'entre eux affirmaient encore ce qu'on ne mesure pas.

## 🏪 21 août 2026 — Le modèle multi-enseignes + barre d'actions ramenée à 5 boutons (v394)

**Ce qui a changé dans le MODÈLE.** On pensait « 1 établissement = plusieurs contacts ». On pense
maintenant **« 1 fiche = un groupe de contacts ET un groupe d'enseignes »**. Cas déclencheur :
Groupe TBF exploite Grain d'Or, Carat, Swarovski — trois marques, trois fiches Google, un seul
décideur (Sabine WYBO, Directrice Marketing du groupe).

**Pourquoi aucun réglage ne pouvait suffire.** `api/gmb.js` sait déjà rattacher plusieurs fiches
Google à une entreprise — c'est ce qui fonctionne pour NORAUTO ×3 — mais il les retrouve **par
ressemblance de nom** (`nomCorrespond`). « Carat » ne ressemblera jamais à « Groupe TBF » : il
faut pouvoir le **déclarer à la main**, et surtout que la déclaration **survive** aux ré-analyses.

### Ce qui a été livré

| Point | Effet |
|---|---|
| **↻ Analyser + synthèse** | Fusionnés. Corrige un **chiffre faux** (voir piège ci-dessous). |
| **Barre à 5 boutons + ⋯** | 10 boutons sur 2 lignes → 5 + menu, sur une ligne. |
| **➕ Rattacher une enseigne** | Autocomplétion Google (1 appel) ou lien Maps. Marque `ajout_manuel`. |
| **Pré-audit par enseigne cochée** | Cases à cocher, coût affiché **avant** le clic. |
| **Portée des contacts** | `c.portee` : `''` = tout le groupe, sinon un `place_id`. |
| **↔ Fusionner deux fiches** | Regroupe les lignes déjà en base (la dédup v389 ne fait que prévenir). |
| **`mes.groupe` dans l'audit** | Le document dit « vos 4 enseignes, 131 avis, 3 sans réponse ». |

### Pièges de cette session (chacun était un bug réel, pas une préférence)

1. **↻ Analyser ne recalculait JAMAIS le score.** `analyserFiche()` ne rappelait pas `scorer()`, et
   le pipeline ne score que `if(!e.score)`. Conséquence mesurée : on corrige la fiche Sofy, la note
   passe de 3,3 à 4,5★, **et la synthèse d'appel continue d'annoncer 3,3**. Le SDR appelait avec un
   chiffre périmé, sans aucun message. La synthèse est maintenant réécrite **si et seulement si**
   `[note, avis, nb_fiches, place_id de la pire fiche]` a bougé — sinon on ne paie pas 0,02 € pour
   réécrire le même texte.
2. **`analyserGmb` détruisait les enseignes rattachées à la main.** `e.gmb = g` avec un `g` issu
   d'une recherche par nom, qui ne peut structurellement pas les retrouver. Même piège que les
   relevés payants effacés le 21/08 : les fiches `ajout_manuel` sont désormais recollées après
   coup, et `par_enseigne` (relevés payants) avec elles.
3. **Le dédoublonnage de contacts à la fusion comparait UNE identité** (email, sinon nom) : sur
   Sabine WYBO, une ligne la porte avec email et l'autre sans → deux clés différentes → la même
   personne dupliquée. Exactement l'erreur des hot leads. On compare l'email **ET** le nom, et un
   doublon **complète** l'existant (c'est souvent lui qui apporte le mobile).
4. **L'aperçu IA et Apple Plans ne se relèvent PAS par enseigne** : ils répondent à une *requête*
   (« bijouterie Les Abymes »), pas à un établissement. Les redemander par enseigne paierait 4 fois
   la même réponse. Coût réel : **~8 relevés pour la principale, ~4 par enseigne supplémentaire**.
5. **Le classement des candidates à la fusion ne peut pas reposer sur le nom** : « Groupe TBF » et
   « Bijouterie Grain d'Or » n'ont rien en commun. Le signal fort est le **contact partagé** (+4)
   ou la **fiche Google partagée** (+4), pas la ressemblance de libellé (+1).

### Ce qui n'est PAS fait, et qu'il faut savoir

- La fusion **ne déplace pas l'historique** d'appels et de notes : il est rangé en base par clé de
  fiche. C'est dit dans la confirmation, pas caché.
- **SerpApi ne peut pas publier sur Apple Plans** — c'est un lecteur, jamais un émetteur. Le canal
  officiel est **Apple Business Connect** (gratuit, API, mode multi-établissements pour les
  prestataires). Conditions d'accès et délai de validation **à confirmer auprès d'Apple** avant
  d'en faire une promesse client. SerpApi garde le rôle de **vérification** après publication —
  c'est la preuve de service, et `api/apple-plans.js` le fait déjà.


> Passation depuis les sessions Claude.ai (Didier + Claude, ~23 sessions).
> Workflow : voir `AGENTS.md` (git pull au début, **validation Didier avant chaque commit+push**, push = déploiement Vercel).
> Didier : débutant en programmation → guidage **pas-à-pas, une étape à la fois, validation à chaque étape, réponses courtes en français**.

## Contexte express

- **Sofy Scrap** = outil SDR interne (listes de prospection, enrichissement, scoring, actions Ringover/Lemlist/HubSpot/Slack/SMS).
- **Prod : https://www.sofyscrap.com** — ⚠️ l'apex `sofyscrap.com` répond **308** vers www → **tout webhook externe doit viser `www.`** (Ringover et Snitcher corrigés ; Lemlist est enregistré sur `sofy-sdr-tool.vercel.app` et fonctionne — ne pas y toucher).
- Front = `public/index.html`, **VERSION courante = v374** (en prod, 21/08/2026). Monter `const VERSION='vNNN'` à chaque livraison front.
- Rôles : Didier=superadmin ; Romain (Head of Sales, à passer superadmin) ; SDRs : Alicia, Franck, Etienne, Sarah. Manon Bouly = coordinatrice AE (ne prospecte pas).
- IA serveur : **claude-sonnet-4-6** par défaut ; **`claude-opus-5` pour la rédaction des analyses client** (`MODELE_PREZ`) et `claude-sonnet-5` pour le filtre likers (`MODELE_FILTRE_LIKERS`). ⚠️ Sur Opus 5, le *thinking* est compté dans `max_tokens` : prévoir large (20 000 pour la prez, sinon les planches manquent).
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


---

# 🎨 ANALYSE CLIENT (« Prez sales ») — la brique majeure d'août 2026

Page web privée, personnalisée, générée par l'IA à partir de **mesures réelles** du prospect, envoyée
par RCS / SMS / email avec **un lien nominatif par destinataire**. C'est le gros du travail des
19–21 août (v320 → v374). Lire cette section avant de toucher à `api/prez.js` ou `api/p.js`.

## Le principe qui gouverne tout

**Rien n'est affirmé, tout est mesuré — et ce qui n'est pas mesurable est dit comme tel.**
La valeur du document tient à ça : un prospect peut vérifier chaque chiffre devant nous. Trois
conséquences dans le code, à ne pas défaire :

1. **Les chiffres ne passent pas par l'IA.** Le scoring (`scorer()`), les défauts de fiche et la
   trajectoire (`trajectoire()`) sont calculés en JS. L'IA rédige les titres, les textes et les
   mécanismes ; elle ne produit aucune valeur numérique. Deux analyses du même client donnaient
   deux prévisions différentes (AGS : 4,2★ puis 4,0★) → corrigé le 21/08 en sortant le calcul.
2. **Les liens ne sont pas écrits par l'IA.** Le bouton « Lire l'interview » vient de
   `kb_sales.lien` ; l'IA ne désigne qu'un numéro de bloc `[#n]`. Une URL inventée dans un
   document signé Sofy est indéfendable.
3. **Aucun échec silencieux.** Un relevé raté est affiché avec sa conséquence réelle. La fenêtre
   ne BLOQUE que si le SDR a un choix à faire (aucune source, ou clé SerpApi HS) ; sinon toast.
4. **🛑 UNE ABSENCE DE MESURE N'EST PAS UNE ABSENCE.** Ajouté le 21/08 après que l'audit de notre
   propre fiche a produit **sept affirmations fausses** — site web « absent » alors que sofy.fr y
   figure, « aucune description » alors qu'elle existe, « aucune photo publiée par vous » sur
   **toutes** les fiches du monde, « aucun bouton WhatsApp » alors qu'il est là, « outil détecté :
   Guest Suite » à propos d'un lien vers leur blog, « aucun dispositif SMS » invisible par
   construction, et un agent RCS présenté comme non déclaré alors que Sofy EST l'agrégateur.
   Un critère ne vaut « faible » que sur une absence **constatée** ; sinon `inconnu`, noté sur 0,
   et son libellé dit ce qu'on n'a pas pu vérifier. Détail complet et liste de ce qui n'est
   structurellement pas mesurable : section **🛑 « Ne jamais affirmer ce qu'on n'a pas mesuré »**
   en tête de ce fichier. **Ne pas défaire sans avoir lu cette section.**

## Chaîne de génération

```
fiche (liste enregistrée)
  └─ completerMesures(i)          public/index.html — relevés SerpApi, AVANT la rédaction
       ├─ /api/avis-reponses      taux de réponse, délai médian, RYTHME de collecte (dates)
       ├─ /api/fiche-audit        photos, complétude, position locale, catégorie, ville, lat/lng
       ├─ /api/ai-visibilite      aperçu IA de Google + concurrents qui PAIENT (même appel)
       └─ /api/apple-plans        présence / position / note sur Apple Plans
     ⚠️ await persisterMaintenant() — /api/prez RELIT la fiche en base
  └─ /api/prez (POST)
       ├─ mesures(e)              tout ce qu'on sait, en JSON, dans le prompt
       ├─ scorer(e)               3 axes calculés en JS (jamais délégués)
       ├─ composer()              2 appels Claude parallèles : SCHEMA_CADRE + SCHEMA_DUELS
       ├─ trajectoire(mes)        les 2 courbes, calculées
       └─ assembler(...)          construit les planches, SUPPRIME les vides
  └─ /p/<jeton>[?d=<n>]           api/p.js — rendu + comptage des ouvertures
```

## Budget SerpApi — ⚠️ 230 APPELS PAR MOIS

C'est la contrainte dure. Coût par analyse complète, telle que le code est écrit :

| Relevé | Appels | Cache |
|---|---|---|
| `avis-reponses` | 2 (3 si repli `data_id`) | 30 j |
| `fiche-audit` | 2 (+2 si relance pour les coordonnées) | 30 j |
| `ai-visibilite` | 1 à 2 (annonces incluses, gratuites) | 21 j |
| `apple-plans` | 1 à 3 (tentatives center → ville) | 30 j |
| **Total** | **6 à 10** | |

→ **environ 30 analyses par mois**, et une régénération sur le même prospect dans la fenêtre de
cache ne coûte RIEN. Règle à tenir : une analyse pour un prospect qui compte, pas pour chaque
appel.

**À faire en priorité : un compteur de consommation SerpApi.** `loggerConso()` journalise
`soreach` et `google_places`, pas SerpApi — il n'existe donc aucun garde-fou. Au-delà de 230, les
relevés échoueront un par un et les analyses se dégraderont sans que personne ne le voie. C'est
exactement la classe de bug qu'on a passé trois jours à éliminer.

## Fichiers

| Fichier | Rôle |
|---|---|
| `api/prez.js` | génération, éditeur (`CHAMPS`/`VERROUS`), destinataires nommés, `trajectoire()`, `scorer()`, `m.mode` prospection/expansion |
| `api/p.js` | rendu de la page publique, comptage, alertes Slack, PDF. Les critères `inconnu` sont sortis de la carte notée et regroupés sous « Non vérifiable depuis l'extérieur » |
| `api/techno.js` | détection des outils du site. `REVISION` + `urlsDuDocument()` → `{charge, liens, marqueurs}` |
| `api/hubspot-check.js` | `emails` **et** `domaines` → statut CLIENT (`lifecyclestage`). La seule source qui voie Soview et SoReach |
| `api/kb-sales.js` | base de connaissance (blocs sourcés, `lien` du témoignage) |
| `api/kb-visuels.js` | bibliothèque d'images (photos SDR, logos clients, ambiance) |
| `api/rcs-prospect.js` | envoi : rich-card RCS `mode:'prez'` + repli SMS |
| `api/avis-reponses.js` `api/fiche-audit.js` `api/ai-visibilite.js` `api/apple-plans.js` | les relevés. `fiche_audit.revision` ≥ 2 = photos/description fiables |

## Pièges — chacun a coûté une livraison ratée

1. **`fallback.text` de la rich-card RCS = 129 caractères MAXIMUM.** Au-delà, l'API v2 refuse la
   carte (400) et tout part en SMS. Ce n'est pas la limite du segment SMS (160) : les deux sont
   à vérifier séparément.
2. **`/api/prez` relit la fiche EN BASE.** Toute mesure ajoutée côté navigateur doit être
   sauvegardée avec `await persisterMaintenant()`, jamais avec `persister()` (différé 400 ms).
3. **Les moteurs SerpApi n'ont pas les mêmes noms de paramètres.** `google`/`google_maps` = `q` ;
   `apple_maps` = **`query`** + `center` (« lat,lng », sans `@`) OU `location`, jamais les deux.
   Un paramètre présent mais VIDE compte pour absent (`URLSearchParams` écrit `center=`).
4. **`num` est refusé sur la première page de `google_maps_reviews`** — paginer par
   `next_page_token`.
5. **L'animation ne doit jamais conditionner la lisibilité.** Couche `.anim` sur `<html>`, retirée
   en cas d'erreur / après 6 s / si `prefers-reduced-motion`. Une `SyntaxError` dans le script
   client laissait toutes les planches à `opacity:0` — « pages vides » signalées trois fois.
6. **Un nombre écrit par un modèle peut arriver en `3,400000000000`** → `nettoyerNombre()`.
7. **La liste « Hot Leads (auto) » est exclue de la boucle des listes du cockpit.** Toute
   recherche de fiche par nom doit l'indexer explicitement (sinon « aucun contact nominatif »).
8. **Un diagnostic non affiché ne sert à rien.** J'ai ajouté deux fois des champs d'erreur côté
   API que l'écran jetait : deux causes différentes donnaient le même message.
9. **Un cache rend une correction invisible.** `fiche_audit` garde 30 jours, `e.technos` reste sur
   la fiche indéfiniment, une requête erronée stockée est relue en priorité. Trois fois le même
   piège le 21/08 : corriger la détection **sans se demander si la correction atteint l'existant**.
   → tout champ dont la sémantique change doit porter une **révision** (`fiche_audit.revision`,
   `techno REVISION` / `TECHNO_REV`), et la révision doit voyager **dans l'objet rendu**, pas
   seulement en base.
10. **Un bouton qui ne peut pas agir ne doit pas être affiché.** `relevesHtml` est appelé avec
   `i = -1` depuis « Ma journée » : le garde-fou `i != null` laissait passer, et `REAL[-1]` sortait
   par un `return` muet. Vérifier les DEUX chemins (fiche complète / Ma journée) pour toute action
   posée dans un bloc partagé — ils n'ont ni le même contexte, ni les mêmes données chargées.
11. **Une instruction du prompt pèse plus qu'une consigne contradictoire.** Le document a servi
   « rien derrière votre WhatsApp » à un client SoConnect parce qu'une instruction la dictait mot
   pour mot, alors que `deja_equipe_sofy` disait l'inverse dans la même charge utile. Quand deux
   informations se contredisent, le modèle suit la plus **précise** — donc c'est la source qu'il
   faut corriger, pas ajouter une consigne par-dessus.
12. **Une liste de noms d'éditeurs codée en dur se périme.** `/crisp|intercom|zendesk|…/` ne
   contenait pas notre propre webchat : un client SoConnect lisait « aucune messagerie web
   détectée ». Raisonner par **catégorie** portée par la signature, jamais par nom.

## Réglages (variables Vercel, aucun code à toucher)

| Variable | Défaut | Effet |
|---|---|---|
| `PREZ_AVIS_MOIS_PAR_FICHE` | 2.3 | rythme de collecte si celui du prospect n'est pas mesurable (mesuré chez Groupe Kiosque : 436 avis / 6 mois / 32 points de vente) |
| `PREZ_FACTEUR_SOLLICITATION` | 2 | multiplicateur appliqué au rythme mesuré du prospect |
| `PREZ_NOTE_AVIS_SOLLICITE` | 4.7 | note moyenne des avis sollicités |
| `PREZ_JOURS_VALIDITE` | 15 | durée de vie du lien |
| `SOFY_RCS_IMAGE_PREZ` | `/rcs-prez.jpg` | visuel de la rich-card |
| `SOFY_SMS_FROM` | `SOFY` | expéditeur SMS (v2 comme v1) |
| `MODELE_PREZ` | `claude-opus-5` | modèle de rédaction |

## Décisions produit prises avec Didier (ne pas rouvrir sans lui)

- **Chiffres mesurés verrouillés dans l'éditeur** : textes libres, valeurs non modifiables.
- **Mention STOP retirée des SMS** (21/08) — « nous avons les accords ». Deux constantes :
  `SMS_AJOUTER_STOP` (`db.js`) et `MENTION_STOP` (`rcs-prospect.js`), à remettre ensemble.
- **Envoi SMS par l'API v2**, v1 en repli (testé : HTTP 201 avec un expéditeur).
- **Bing écarté** : ~3 % des recherches en France, l'angle IA est déjà tenu par l'aperçu Google.
- **Le module se choisit** avant la génération (Soview / SoConnect / SoReach / Générique).
- **Alertes Slack plafonnées** : 1ʳᵉ ouverture, puis 1 alerte/4 h, jamais au-delà du 3ᵉ lecteur ;
  les aperçus de lien (Slack, Gmail, WhatsApp) ne comptent pas comme lecteurs.
- **Sur un client, le document CHANGE DE NATURE** (21/08, option b choisie parmi trois) : mode
  `expansion`, planches « LEVIER » au lieu de « PROBLÈME », « Ce qui reste à gagner » au lieu de
  « Ce que ça coûte ». L'alerte avant génération reste **informative**, pas bloquante : le SDR
  assume, mais il est prévenu **avant** le choix du module.
- **Le constat d'un SDR est une source valide**, à condition d'être daté, signé et présenté comme
  tel dans le document (« constaté sur la fiche, pas relevé automatiquement »). Un fait vu par un
  humain n'est pas moins solide qu'un fait relevé par une API — il est d'une autre nature, et ça
  doit se voir. C'est ce qui débloque le bouton WhatsApp de la fiche Google.
- **Un critère non vérifiable ne se supprime pas, il se déplace** : hors de la carte notée, sous
  « Non vérifiable depuis l'extérieur — à regarder ensemble ». Une puce dans une carte notée est un
  reproche, quelle que soit sa couleur.

## Backlog de cette brique

1. ✅ **Compteur SerpApi + garde-fou à 230/mois** — fait (`api/serpapi.js`, écran Maintenance).
2. **Propriété HubSpot « modules souscrits »** (nouveau, 21/08) : HubSpot dit « client », pas quels
   modules. Avec cette propriété, le badge « ❔ Soview : à vérifier avec lui » devient une mesure, et
   le mode expansion sait exactement de quoi parler. Lecture dans le même appel, coût nul.
   **→ à trancher avec Didier : la propriété existe-t-elle dans HubSpot ?**
3. Envoi d'email **serveur** : aujourd'hui `mailto:` pré-rempli depuis la messagerie du SDR
   (aucun expéditeur transactionnel configuré). Nécessite un fournisseur + une clé.
4. Rythme de collecte réel par secteur : `PREZ_AVIS_MOIS_PAR_FICHE` s'appuie sur un seul client
   mesuré (retail). Un rythme de déménageur / garagiste rendrait la courbe plus juste.
5. Variante « après démo » du document (aujourd'hui pensé pour l'avant-vente) — le mode `expansion`
   en pose la moitié : il reste à décider si « après démo » est un troisième mode ou une variante.
6. Exploiter les decks Partoo pour l'objection « on a déjà Partoo ».
7. **Apple Business Connect** (nouveau, 21/08) : SerpApi ne publie RIEN, c'est un lecteur. Le canal
   officiel pour créer / tenir à jour un établissement sur Apple Plans est Apple Business Connect
   (gratuit, API, mode multi-établissements pour les prestataires). Vraie piste produit Sofy.
   ⚠️ Conditions d'accès et délai de validation **à confirmer auprès d'Apple** avant d'en faire une
   promesse client. SerpApi garde le rôle de **vérification** après publication (`api/apple-plans.js`).
8. Rotation du mot de passe Neon (collé dans une session ancienne, toujours actif) ; supprimer
   les branches `recuperation-alicia*`.

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
- **v254 — Performance** (commit 317d52c) : suite au ressenti « plus lent » de Didier. ⚠️ PIÈGE MAJEUR : `ensureSchema()` (api/db.js) est désormais gardé par la constante **`SCHEMA_VERSION`** comparée à `config.schema_version` en base — les ~53 requêtes de migration ne tournent que si la constante a été incrémentée (sinon 1 SELECT ; avant : 1,5-2,5 s de latence Neon à CHAQUE démarrage à froid de CHAQUE fonction). **Toute nouvelle table/colonne dans ensureSchema = incrémenter SCHEMA_VERSION dans le même commit**, sinon la migration ne s'exécute jamais en prod (symptôme : « column does not exist »). + cockpit : Statuer…/Fait ✓ en mise à jour locale (zéro refetch des 40 listes) et cache 60 s des stats Ringover.
- **v255 — Séquences par température** (commit c26e687, SCHEMA_VERSION 2) : `api/sequences-cron.js` (cron 06:00 UTC lun-ven, **`?dry=1` = simulation sans envoi**) — bascule auto vers Lemlist des leads ❄️ froids (Pas de réponse/Message vocal/Absent + **3 tentatives** = 1 statut + 2 rappels faits) et 🌡️ tièdes (Demande doc immédiat ; Rappel demandé sans suite 7 j sans rappel pendant). Campagne du produit dominant (**V1 partagée**, variable `temperature` pour les templates), mêmes variables que l'envoi manuel (email IA `objet_perso`/`email_perso` inclus), plafond 50/SDR/24 h partagé + 100/run, exclus si STOP/HubSpot/déjà en séquence. Traces : sequenceAdded + note bloc-notes + badge ✈️ Séq. auto + DM Slack récap. **Interrupteur « Séq. auto : ON/OFF » par liste (défaut ON, opt-out)**. + garde-fou création : un SDR avec 3 listes actives < 50 % enrichies ne peut plus créer de liste (admin passe) ; bannière cockpit « liste jamais enrichie ». **1re simulation (22/07) : 6 leads sur 35 listes — validée par Didier, 1er run réel au cron du 23/07 8 h.**

## Fait le 23 juillet 2026 — Cockpit v2 sur retours SDR (v256-v259)

Premiers retours terrain des SDR sur « Ma journée » → 3 lots livrés le jour même, tous testés OK par Didier.

- **Lot 1 (v256, commit 2deccc3)** : 🐛 fix recherche Historique — en mode recherche les résultats s'affichent TOUS statuts confondus (avant : une liste archivée/nurturing trouvée restait cachée par l'onglet « En cours ») + LIMIT 50→200 (vieilles archives introuvables) ; requête de listing unifiée (filtres neutralisés par booléens) avec `client=` (champ « Nom du client ») et `sdr_filtre=` (sélecteur SDR/AE admin) ; ☀️ Ma journée = onglet en tête de sidebar + vue par défaut à l'ouverture ; bouton ⇄ sidebar réductible (mémorisé) ; tuiles Ringover auto-rafraîchies.
- **Lot 2 (v257, commit 194b004) — statuts intelligents (fiche ET cockpit)** : « Rappel demandé » → modale rappel OBLIGATOIRE (fermée sans date = rappel par défaut demain 9 h — la promesse ne se perd jamais) ; « Pas de réponse / Message vocal / Absent » → re-tentative AUTO à J+2 9 h 30 sans popup (remplacée si recontact — anti-doublon /api/taches ; statut terminal → `cloreRappels()`) ; « Refus – concurrence » → modale concurrent (Partoo, Digitaleo, Uberall, Solocal, Localnord, Local Ranker, smsmode, SMSEnvoi, Esendex, MTarget, Sinch, Autre) → `fiche.concurrent_perdu` + note 🥊 ; « Non décisionnaire » → hors file, Personas proposé ; panneau cockpit : « ✈️ Séquence Lemlist… » (contact + produit, défaut = produit dominant, variables complètes serveur `it.vars`, PUT `marquer_lemlist`).
- **Lot 3 (v258-v259, commit 734e554) — cockpit v2** : l'étage « signaux » devient **3 tuiles cliquables (filtres)** : 🔥 HOT signaux+signups **partagés équipe** (fiches liste Hot Leads auto non statuées, claim « **Je prends** » = PUT `prendre:true`, verrou premier arrivé → 409 « Déjà pris par X », annonce au canal Slack `SLACK_WEBHOOK_URL`, badge « à toi », chrono) ; ⏰ Rappels promis ; 🔁 À retenter (tâches « re-tentative auto », scindées par la description). **« Ma prospection » par liste** : sélecteur `?liste=` (restantes/total + barre), mémorisé par SDR (localStorage `ck_liste_<nom>`), bannière « Reprendre la liste d'hier ? » (liste la plus travaillée hier non finie, ignorable 1 jour). **Panneau déplié : HISTORIQUE** (6 dernières activités via /api/activite, chargées au dépli) + note rapide. Rafraîchissement silencieux 2 min (re-render seulement si la file change, toast 🔥 si nouveau signal). ⚠️ PIÈGE réglé : `.sb-min{grid-template-columns:1fr}` — avec `0 1fr` + aside display:none, le main atterrissait dans la colonne de largeur 0.

## Fait le 23-24 juillet 2026 — Ouverture ciblée, Verticale groupe/annuaire web, fuseau cockpit (v260-v263)

- **v260-v261 (commits aec8737 + 349502f) — 🐛 ouverture ciblée depuis l'Historique** : « Ouvrir » transmet le terme cherché (recherche libre OU nom du client, helper `histTerme()`) et l'ouverture survit aux rendus asynchrones — `rerender_all()` ré-applique `filtrerFiches` si le champ de recherche est rempli (les chargements Ringover/engagement écrasaient le filtrage → « je retombais sur les 26 fiches »). + bouton « Réinitialiser » les filtres de l'Historique.
- **v262 (commit cf19dbb) — Verticale groupe (cas Citadelle, 1re partie)** : SIREN à 9 chiffres accepté directement dans le champ (zéro ambiguïté) ; les 8-16 premiers candidats sans ville sont enrichis ville/CP via /entreprise à la résolution (chips lisibles) ; champ « Département » optionnel ; le wizard Pappers étape 1 renvoie en 1 clic vers la Verticale.
- **v263 (commit aa7ebb7) — moteur 🌐 « Annuaire web »** (3e moteur Verticale, cas Algorel) : le SDR colle l'URL d'une page « nos adhérents / points de vente / agences » → lecture serveur (anti-SSRF, **alt des logos remontés en texte**, pagination `?page=N` suivie, max 10 pages) → Claude extrait les sociétés (nom/ville/CP, regroupées par société) → à la création : SIREN + dirigeant via Pappers /recherche (département du CP prioritaire), cessées écartées, dédup inter-listes par SIREN, contacts Basile. **Sociétés introuvables sur Pappers = fiche créée quand même** (nom + ville suffisent au pipeline GMB). L'extraction de l'estimation est réutilisée à la création (`VERT_WEB`). Bloc contacts Basile factorisé (`ajouterContactsBasile`, partagé groupe/web). Limite connue : pages 100 % JavaScript illisibles (message explicite). Test local validé sur algorel.fr (45 noms + 4 pages de pagination).
- **Commits 0918c9d → e8cdf3b — Verticale groupe (cas Citadelle, 2e partie, élucidé via debug)** : nouveau debug superadmin `?debug=1&endpoint=arbre&siren=…` (représentants, bénéficiaires effectifs, mandats bruts, arbre). Deux vrais bugs corrigés : (1) la qualité du dirigeant est jugée **mandat par mandat** (`ent.dirigeant.qualites`) — au niveau de l'enregistrement, « Liquidateur » de 2 GIE dissous écartait TOUS les mandats de la holding ; (2) **stratégie REMONTÉE** : le dirigeant personne morale de la racine (ex : GROUPE COMTE-SERRES, président de CITADELLE) devient une co-racine explorée par les 3 stratégies (mandats/dirigeants physiques/bénéficiaires) — pattern courant des groupes familiaux DOM. Résultat Citadelle : 0 → **33 entités** (SODIVA, CCIE/Toyota, PDK/Porsche, réseau pneumatiques 971/972/973/974/976). + tri : **le département saisi prime désormais sur le nombre de mandats** (un homonyme métropole à 5 mandats écrasait le vrai groupe).
- **Fuseau cockpit (24/07, testé OK par Didier)** : `api/cockpit.js` calculait « aujourd'hui » en UTC (serveur Vercel) → à 1 h du matin heure de Paris, le cockpit affichait les stats de la VEILLE sous la date du jour. Bornes jour/mois désormais en **heure de Paris** (helpers `jourParis()`/`debutJourParis()`/`offsetParisMs()` — minuit Paris = 22:00Z en été). Concerne : appels Ringover du jour, statuées, RDV jour/mois, moy 7 j, rappels « aujourd'hui ». Convention : la journée = heure de Paris pour toute l'équipe.
- **v264-v265 — ouverture ciblée : la fiche se DÉPLIE** : la fiche trouvée s'ouvre automatiquement (détail déplié via `toggleFiche`, garde « traité par un autre SDR » respectée) puis scroll + surlignage — avant elle n'était que surlignée, il fallait re-cliquer. v264 = chemin recherche Historique (`termeRecherche`) ; v265 = chemin ciblé `cibleFiche` (« Ouvrir la fiche complète » du cockpit, liens profonds Slack) + repli de correspondance si la clé `cleSignal` ne matche pas (la clé finit par le nom).
- **💸 Coût API Anthropic + fiabilité Insights (07/08 soir, commits 019c970 → 369e484, testés OK)** : facture juillet **268 \$** (225 tokens + **43 \$ de recherche web ≈ 4 300 recherches à 10 \$/1000**), tout sur Sonnet 4.6, **aucun prompt caching**. Lot appliqué (v321-v323) : ① **Haiku 4.5 sur les tâches mécaniques** — extraction d'annuaires (verticale) et de profils (linkedin) ; ⚠️ **Sonnet MAINTENU sur le filtre des likers et le tri sectoriel des listes IA** (arbitrage Didier : un faux positif pollue les Hot Leads, une liste mal ciblée coûte une journée de SDR — les 2 \$/mois d'économie ne valent pas le risque) ; ② `web_search` **max_uses divisé par 2** partout (ia 4→2 et 6→3, personas 6→3 ×2, email-web 4→2, linkedin 3→2) ; ③ **verticale : 600 000 caractères envoyés à l'IA** (0,45 \$ d'input par appel !) → nettoyage HTML (scripts/styles/nav/footer/commentaires) puis plafond 120 000 → ~0,06 \$ ; ④ **anti-recalcul** : score/analyse de moins de 30 j ne se re-payent plus par inadvertance (confirmation chiffrée, horodatage `score_le`/`analyse_le`, `{force:true}` pour les flux légitimes) ; ⑤ **test Sonnet 5 sur le filtre des likers** (`MODELE_FILTRE_LIKERS` surcharge sans redéploiement, modèle affiché dans le rapport d'import) — plus capable ET tarif d'introduction inférieur à 4.6 jusqu'au 31/08/2026. **Cible ~100-130 \$/mois** ; restent en réserve : prompt caching (−30 à −50 % en rafale) et Batch API pour le coach nocturne (−50 %). **⚠️ Bug Insights corrigé (v323)** : les tuiles affichaient 107 € / 2 ventes / ROI 0× puis 11 420 € / 6 ventes quelques secondes plus tard — `noshow.js` enchaîne ~10 appels HubSpot et **un 429 faisait contribuer 0 deal au pipeline concerné**, la réponse partielle s'affichant comme définitive → `hsFetch` (3 tentatives, attente progressive, drapeau `incomplet`), le front n'écrase plus des données complètes par du partiel + relance à 4 s + mention « ⏳ HubSpot partiel ». Piège au passage : `const etatHS` utilisé avant sa déclaration (TDZ) = endpoint mort.
- **📊 Diagnostic de charge + hygiène base (07/08 soir, commits f3ba83a → e5a51e9)** : `api/diag-charge.js` (superadmin, lecture seule) mesure le poids réel (`pg_column_size` par liste), la taille des tables, le chrono des requêtes réellement utilisées et projette à ×3/×10. **Résultat du 07/08 : la crainte d'un problème de dimensionnement était infondée** — 65 listes / **1 597 fiches** / **3,78 Mo** de données métier / **2,4 Ko par fiche** ; scan complet Insights **1,1 s** (plafond 120 s), cockpit d'un SDR **99 ms** (plafond 30 s) → **la table `fiches` n'est PAS urgente**, marge jusqu'à ×10. **Déclencheur à surveiller : si le scan Insights dépasse 5 s, pré-calculer les agrégats (½ j)** ; relancer le diagnostic chaque trimestre. **Vraie découverte : `lemlist_events` = 32 Mo / 18 411 lignes** (8× les données métier), payloads bruts jamais purgés, sans index, lus en `DISTINCT ON` full-scan à chaque webhook (~200/j) → `api/purge-cron.js` (cron mensuel `0 4 1 * *`) : **2 index créés** (`lower(email), recu_le` + `recu_le`, gain immédiat), rétention 90 j avec re-dérivation des profils LinkedIn AVANT suppression, `VACUUM ANALYZE`, `?dry=1` / `?jours=N`, bloc `age` (plus ancien, rythme/jour, quand la purge mordra, palier stable). Au 07/08 : 0 à purger (tout l'historique < 90 j) — le cron empêchera la croissance vers ~130 Mo/an. Autres constats : 65 listes pour 1 597 fiches = beaucoup de listes de test à archiver ; colonne de date des listes = `created_at` (pas `cree_le`).
- **💬 RCS de démonstration — corrections v320 (07/08 soir, commit 43e0637, testé OK)** : cas fiche « hot lead manuel » — ① `sourceFiche()` distingue enfin le type réel du signal (➕ Ajout manuel, 🆕 Signup) au lieu d'afficher « 💼 source LinkedIn » pour tout hot lead ; ② bouton **💬 RCS démo sur la fiche** (à côté de SMS/RCS Sofy, `ouvrirRcsProspectFiche` choisit le contact avec mobile) — il n'existait que dans le cockpit ; ③ la note du bloc-notes n'était écrite **que si un email existait** → clé de repli `cle_fiche` (`nom:…`, envoyée par le front depuis `cles_histo`/`clesFiche`) + rechargement de l'historique de la fiche ouverte après envoi ; ④ ligne signal « 🔥 💙 a réagi » remplacée par « ➕ ajouté manuellement — appel entrant » quand `signal.type==='manuel'` ; ⑤ **GARDE-FOU anti-envoi en masse** : un seul RCS de démonstration par lead, contrôlé **côté serveur** (409 si une activité `rcs_prospect` existe déjà pour cette fiche OU ce numéro, avec date + auteur) — un simple bouton grisé n'aurait pas survécu au rechargement ni protégé entre SDR.
- **🗓️ 07/08 après-midi — cockpit v310→v319 + veille (testés OK)** : ① **Extracteur likers refait 3 fois** (LinkedIn a changé l'UI des réactions) : plus de `role=dialog` ni `.artdeco-modal`, le mot « Réactions » n'existe plus comme texte DOM → **détection par visibilité au premier plan** (getBoundingClientRect + `document.elementFromPoint` : le fil derrière l'overlay est exclu tout seul), **défilement du vrai conteneur** (`scrollTop`, pas `scrollIntoView` qui ne fait rien sur un élément déjà visible — symptôme : « … 9 profils » 3× sans bouger), collecte cumulative, log de progression. Limites normales : pages entreprise et profils privés (« Membre LinkedIn ») non extractibles → 44/48, 13/14. ② **Filtre IA par LOTS de 25** (max_tokens 2000) : à 91 profils la réponse était tronquée → JSON illisible → l'ancien repli « tout garder » polluait les Hot Leads ; désormais un lot dont l'IA échoue est EXCLU et signalé (« non analysé — relance avec ♻️ »). Consignes durcies : chefs de projet, product managers/owners, formateurs, coachs, designers, devs. ③ **Bibliothèque de sources** `api/sources-veille.js` (config `sources_veille`, 15 sources d'amorçage concurrents/adjacents/médias/salons/DOM) : bloc 📚 dans la modale d'import (tri par ancienneté, froides ≥14 j en orange, clic = ouvre + préremplit, marquage auto « scrapé » avec nb de leads après import) + **cron lundi 6h UTC → DM Slack aux admins** avec les 4 sources les plus froides. ④ **Cockpit** : plafond hot 12→50 avec `hot_total` (le compteur affichait 12 = tout ce qu'il y avait, faux), **filtres par source** (chips LinkedIn/visite/signup/manuel/engagement), **20 max affichés + lignes compactes**, **4e tuile « Ma prospection »** (listes en chips avec volumes, sélectionnée par défaut sans hot ni rappel, file limitée à 20), **hot leads dépliables** comme les fiches (contacts + WA/SMS/↻ Compléter, accroche, historique, ✈️ Séquence, 👥 Personas, fiche complète ; « Statuer… » seulement une fois pris ; Personas grisé si `societe_ok` false). ⑤ **💬 RCS de démonstration** `api/rcs-prospect.js` : bouton violet à côté de SMS dans le dépli → modale d'aperçu ÉDITABLE → rich-card (visuel `/rcs-demo.jpg`, texte tiré de l'accroche IA, bouton « 📅 Réserver ma démo » vers go.sofy.fr) ; repli SMS v1 ; mention STOP auto (prospection B2B) ; conso SoReach + note fiche. ⚠️ **Piège coûteux** : `catch (_) {}` silencieux autour du bloc hot du cockpit — une faute de frappe (`c0` au lieu de `c0H`) a vidé la tuile HOT de tous les SDR sans le moindre message (commit cda3a09). À rendre bavard un jour (log + champ `erreur_hot`).
- **🛡️ Rappels — liens Slack + textes généralisés (07/08 matin, commits 592d044 + ab05ed6, testés OK)** : ① le récap Slack porte un **lien cliquable vers la fiche contact HubSpot** (portal id via /account-info/v3/details) + le **titre de la réunion** — né du cas Cyril Travostino/Marine Linard : contacts inconnus de Sofy Scrap car le cron lit TOUTES les réunions HubSpot (inbound/AE/CSM), pas seulement les RDV pris par les SDR ; ② décision Didier : pas de filtre par type de réunion — tous les textes passent de « démo » à « **votre rendez-vous Sofy** » (messages, replis, agenda Google, page de confirmation, Slack), cohérent avec le visuel « Votre rendez-vous approche » et juste quel que soit le type de réunion. Premiers envois réels du cron le 07/08 au matin (2 × H-2 rcs) ✓.
- **🛡️ Rappels démo v2 + cascade SMS (07/08, commits 292efd3→ae57a26, TESTÉS OK)** : ① **J-1** : bouton unique « ✅ Je confirme mon RDV » → `api/rdv-confirme.js?m=<meeting>&t=<jeton HMAC>` (page « c'est confirmé » + bouton 🗓 Agenda Google, alerte Slack 🎉, note ✅ sur la fiche, `reponse='confirmé'` en base — un seul bouton autorisé par rich-card, l'engagement actif prime) ; **H-2** : bouton « 🗓 Ajouter à mon agenda » (lien Google Calendar direct, helper lienAgenda) ; textes engageants (bénéfice « 30 minutes pour booster vos avis Google… », prénom, AE, n° du SDR pour l'imprévu) ; `rcs_rdv_envoyes` porte email/date_rdv/reponse (ALTER ADD IF NOT EXISTS). ② **Cascade d'envoi : RCS rich-card → SMS v2 → SMS v1** — la route SMS **v2 est « rejected by provider » TOUTES destinations** (from défaut = code court DOM 36789 ; ids 01KZCJFH…/01KZCJMZW… remontés à Stephen avec les retours DX : fallback.text ≤129 non documenté, button https only → feature request dial, schéma webhooks absent de l'openapi) ; l'étage v1 (`envoyerSmsSofy`) a gagné une option **`transactionnel:true` = route ALERTE** (pas de STOP, pas de fenêtre horaire — testé reçu à minuit passé ; les SoReach marketing inchangés). Tests : `?test_tel=<num>` (RCS), `&canal=sms` (v2), `&canal=sms&v1=1` (v1 alerte) ; le test crée un meeting fictif 'test' pour valider le bouton de confirmation de bout en bout. Quand Stephen aura provisionné l'expéditeur SMS v2, l'étage v2 reprendra sans retouche.
- **💬 Webhook réponses RCS/SMS (07/08, commit 659403c, TESTÉ OK de bout en bout)** : `api/sofy-reply.js` — créé via `?setup=1` (POST /v2/webhooks, events sms.reply + rcs.reply, secret HMAC remis une fois → config 'sofy_webhook') ; réception POST signée (X-Sofy-Signature = HMAC-SHA256 de `timestamp.corps_brut`, bodyParser désactivé, fenêtre ±5 min) → alerte Slack « à rappeler à chaud » + note 💬 dans le bloc-notes de la fiche (contact retrouvé par numéro via rcs_rdv_envoyes, qui stocke désormais l'email — ALTER ADD COLUMN IF NOT EXISTS). Sonde `?debug=1` = dernier payload brut (schéma non documenté, extraction défensive). Gestion : `?liste=1`, `?supprimer=<id>`. Note Slack équipe sales (features + transparence Coach IA) préparée et remise à Didier le 07/08.
- **🛡️ Anti no-show RCS (06/08, commits b5ab68e→086ec8a, TESTÉ OK sur mobile Didier)** : `api/rcs-rdv-cron.js` (cron horaire ouvré `20 5-16 * * 1-5`) — réunions HubSpot des 26 prochaines h (annulées exclues) → contact associé (associations v4 + batch) → mobile E.164 (DOM : 0690→+590, 0696→+596, 0694→+594, 0692→+262) → **rich-card RCS** à J-1 (fenêtre 23-25 h) et H-2 (1 h 30-2 h 30) via `api.sofy.fr/v2/rcs/rich-card`. Message : prénom, date, **nom de l'AE** (owner de la réunion), **n° Ringover du SDR sourceur** (fiches Sofy statut RDV → traite_par → sdrs.ringover_numero), émojis, visuel hébergé `https://www.sofyscrap.com/rcs-rdv.jpg`, bouton « 📞 Je reporte mon RDV ». Anti-doublon table paresseuse `rcs_rdv_envoyes` (UNIQUE meeting+type, libérée si envoi KO) ; trace dans le bloc-notes de la fiche (activites par email) ; récap Slack ; kill-switch config `rcs_rdv.actif=false`. Debug : `?dry=1` (+`&tout=1` fenêtres ignorées), `?test_tel=<num>` envoi réel, `?statut=<id>` acheminement, `?senders=1` expéditeurs RCS. **⚠️ PIÈGES API Sofy v2 (4 itérations de test réel)** : ① clé = jeton Bearer `sofy_live_…` (env `SOFY_API_KEY_V2` — SOFY_API_KEY existant = v1, et l'envoi SMS SoReach v1 via SOFY_API_KEY_ID/SECRET reste intact) ; ② `fallback.text` ≤ **129 caractères** (repli court dédié) ; ③ `button.url` doit être **https** (pas de `tel:`) → page de rebond `public/appel.html?tel=…` qui lance le composeur ; ④ `SOFY_RCS_SENDER_ID` = **identifiant technique** de l'expéditeur (listés par `?senders=1`), pas le nom « sofy » (« sender is not an rcs sender for this organization ») ; ⑤ `from` SMS alphanumérique non déclaré = « rejected by provider » → from envoyé seulement si `SOFY_SMS_FROM` est défini. En réserve validé : webhook `sms.reply` → alerte Slack + note fiche (à enregistrer côté dashboard Sofy).
- **📅 CA annualisé (v309, testé OK) + graveyard Lemlist (06/08)** : ① par vente conclue, `📅 ≈ X €/an` = valeur contractuelle 12 mois — MRR des **abonnements Zoho actifs** du client × 12 + one-shot facturé (`transaction_type` ≠ renewal/subscription : packs SMS, frais d'installation) ; sans abonnement → facturé tel quel ; sans facture → devis à valeur faciale (cas contrôle : Bourbon 759 €/mois × 12 + 499 € ≈ 9 607 €) ; total en légende + tuile CA ; les montants d'abonnement peuvent être HT vs factures TTC (d'où le ≈, écart ~8,5 % possible). ② Erreur « Email address is in the graveyard » (cas Alicia) = l'email a déjà existé dans Lemlist puis supprimé/désinscrit → Lemlist bloque le ré-ajout ; lemlist.js renvoie désormais un 409 explicite avec marche à suivre (désinscrit = ne JAMAIS relancer par email ; suppression passée = un admin le retire dans Lemlist → Settings → Graveyard). Décision : pas de retrait automatisé (RGPD).
- **💶 Chantier Zoho Billing + KPI Head of Sales (06/08, v301→v308, testés OK au fil de l'eau)** : connecteur `api/zoho.js` (OAuth Self Client : env ZOHO_CLIENT_ID/SECRET/DC + `?setup=1&code=` superadmin → refresh_token en config 'zoho' ; org multi-comptes : `?orgs=1` liste, `?org=<id>` choisit — SOFY FRANCE = 795598526 ; re-setup conserve l'org). Scopes actifs : invoices, customers, settings, **estimates, creditnotes, subscriptions**. `?ca=1&du=&au=` = factures fenêtrées (champ **invoice_date**, pagination sort desc arrêtée après une page hors fenêtre, draft/void exclues, plafond 1000) + `devis_acceptes` ; `?lignes=<ids>` = articles des factures ; `?debug=1` sonde. **Insights** : tuile 💶 CA VENTES CONCLUES (= factures rapprochées des deals gagnés HubSpot, PAS la facturation globale) + 🧲 ROI PROSPECTION (CA ÷ coût période, coût/vente new) ; panneau Ventes : camembert New/Parc (montants par segment), 📦 CA par module **ventilé par lignes de factures** (SO-VIEW 440 ≠ SO-CONNECT 319, rubrique 🔧 Frais & licences, repli nom du deal à parts égales), 🏅 indice de perf par SDR (RDV pris, ventes facturées, CA, €/RDV) et par AE, origine du lead (propriété HubSpot `revops_source`) + sourceur (propriété `sdr` du deal, repli fiches Sofy `rdv_sourceurs` de stats-journees), sélecteur SDR appliqué aux tuiles ventes/CA/ROI. **Règles clés** : rapprochement deal↔facture HIÉRARCHIQUE avec arrêt au 1er niveau (nom↔nom, email exact du contact associé au deal — récupéré via associations v4 + contacts batch dans noshow.js —, domaine si UN seul client le porte [gbh.fr = groupe → ambigu], nom↔domaine ; domaines génériques exclus) ; « **pas de facture = pas de vente** » : gagnées sans facture hors CA/camembert, listées en ⏳ (avec 📝 devis accepté si trouvé) ; fenêtre factures élargie jusqu'à aujourd'hui (vente fin de mois facturée après) ; le panneau déplié se re-rend au changement de période/SDR (stjRafraichirPanneau). ⚠️ Pièges : réponse Zoho paginée à 200 par défaut (Somarec perdu à cause du slice), montants Zoho = point décimal (€99.000 = 99 €), `montant` = TTC (le rapport Zoho « ventes » est HT), écart ~3 % = avoirs (scope actif, déduction pas encore implémentée).
- **v298-v299 + affinages filtre (05-06/08, commits 15b21aa → bf91c24, testés OK)** : ① **rapport d'import détaillé** : le résultat liste le sort de CHAQUE profil (🔥 hot leads créés, 🎯 signaux sur listes en veille, 🚫 exclus AVEC RAISON, ⏭ déjà traités) dans la modale qui reste ouverte ; seuls les profils GARDÉS sont marqués « vus » (les exclus restent repêchables) + case ♻️ « ré-analyser les déjà importés » (`forcer:true`) — cas Justine T./post Pongo, indiagnosticable avant. ② Filtre affiné sur cas réels : tagline mots-clés B2C sans employeur = gardée (doute → SDR) MAIS **vendeurs exécutants exclus** (Inside Sales/AE/SDR/BDR/CSM — cas Daniela Belz, post Partoo) ; **employeur détecté aussi dans l'URL du profil** (cas /in/titouan-billy-partoo/ sans Partoo dans la tagline) ; comparaison employeur sans espaces/tirets (« Hey Pongo » ↔ heypongo). ③ **Accroche d'appel** : fidèle au sujet RÉEL du texte du post (interdiction d'inventer — elle parlait d'avis Google sur un post SMS Partner) + orientée vers le module Sofy du concurrent auteur (config concurrents + repli mots-clés : sms→SoReach, avis/local→Soview) ; 40 mots max + limite 450 car. (plus jamais coupée, veille + email-angle). ④ **v299 — bouton ➕ Hot lead de « Ma journée » réparé** : la modale hotlead-modal était déclarée DANS view-params (parent masqué depuis le cockpit → invisible) ; déplacée au niveau document après `</main>`. ⚠️ Piège récurrent : toute modale position:fixed ouvrable depuis plusieurs vues doit vivre HORS des `<section class="view">`.
- **Fix RDV « 2 pour 1 » (05/08, commit d14551e, testé OK)** : la tuile 🏆 du cockpit et le journal du soir (`journee-cron` → `journees_sdr` + bilan Slack) comptaient les **lignes** d'activité `source='rdv'` — or « RDV pris » (clic 🤝 réserver pour un AE) ET « RDV confirmé » (📅 récupération du créneau HubSpot) écrivent chacun une ligne sur la même fiche → Alicia affichait 2 RDV pour 1 réel (Guiraud Distribution). Règle désormais partout : **1 fiche = 1 RDV** — `COUNT(DISTINCT lower(fiche_cle))` + exclusion du titre « RDV confirmé » (couvre aussi le double-clic). Les Insights n'étaient PAS touchés (totaux RDV recalculés en direct depuis les fiches au statut RDV) ; les journées déjà consignées avant le fix gardent leur ancien compte.
- **v293-v294 (commits cf5c3a3 + 3ffbe09) — import likers : fiabilité extracteur + accroche visible + société via IA (testés OK)** : v293 = ① l'extracteur console scanne **TOUS** les dialogues (`[role="dialog"]` + `.artdeco-modal` — sur certains posts le premier dialogue du DOM est un dialogue caché vide → il renvoyait `[]` muet) et affiche un retour explicite « ✅ N profils copiés » / « ⚠️ 0 profil » ; ② les 4 champs de la modale d'import sont vidés à chaque ouverture (ils gardaient le scraping précédent). v294 = ① l'**accroche 🗣** (générée depuis le texte du post) est un champ dédié `signal.accroche` ET s'affiche sur la fiche (encadré orange sous le signal, helper front `accrocheSig()` qui relit aussi le `detail` des fiches d'avant — rétro-compatible) ; ② elle est injectée dans l'email personnalisé (`sigPourEmail` → `/api/email-angle` : « reprends ce THÈME dans l'ouverture ») ; ③ l'IA du filtre extrait la **société** depuis la tagline quand elle y figure (`"societes":{indice:nom}` — « Head of sales @ Décathlon » → Décathlon), plus seulement le motif « chez ». ⚠️ Limites structurelles (cas Hugo de Montrichard/Axialys) : tagline sans société → seule l'ouverture du profil via enrichissement la retrouve, et le filtre IA ne peut pas exclure un employé d'éditeur si sa tagline ne nomme pas l'employeur ; accroche générée UNIQUEMENT si le texte du post est collé à l'import.
- **v292 — import likers : lien du post sur la fiche + accroche IA + filtre encore durci (import testé OK en réel)** : ① champ dédié « 🔗 URL du post » dans la modale → `signal.post` porté par ajouterHotLead (badge « 🔗 Voir le post » sur la fiche via postSig) + dérivation de l'entreprise auteure depuis cette URL ; ② champ « Texte du post » (optionnel) → le filtre IA génère en plus une **accroche d'appel** (« J'ai vu que vous avez réagi au post de X sur… ») ajoutée au détail du signal de chaque lead de l'import ; ③ filtre IA durci (cas Marie-Laure Collet, présidente Apec/Syntec/Medef passée au travers) : EXCLUS aussi fédérations/syndicats pro, présidents d'associations/fondations, cabinets conseil/audit, banque/assurance corporate, collectivités — la cible a des BOUTIQUES/AGENCES/clients grand public ; « fonction prestigieuse mais hors commerce B2C = exclure ». Compteurs `exclus_employeur`/`exclus_ia` dans la réponse.
- **v289-v291 — import likers durci + filtre IA + hot lead manuel** : v289 = extracteur limité à la fenêtre des réactions (`[role=dialog]` — il balayait TOUTE la page : faux profils du fil) + « malou » ajouté aux concurrents exclus ; v290 = l'extracteur capture la FONCTION (tagline de la ligne) ; v291 = ① lignes de statut LinkedIn (« Out of network »…) exclues de la fonction ; ② **filtre IA en amont** (demande Didier) : 1 appel claude-sonnet par import qualifie le lot — seuls les profils DANS LA CIBLE (décideurs marketing/commercial/direction d'entreprises B2C : commerces, retail, franchises, CHR, auto…) deviennent des hot leads ; exclus : étudiants/alternants, scientifiques, freelances/agences, RH/tech, employés d'éditeurs ; fonction vide = gardé (doute → SDR) ; les profils qui matchent une liste en veille COURT-CIRCUITENT le filtre ; `exclus_ia` dans la réponse ; IA en panne = tout gardé (comportement d'avant) ; ③ **➕ Hot lead manuel** : bouton dans l'en-tête de « Ma journée » → modale (contact, entreprise, fonction, email/tél, source appel/email/salon/reco, contexte) → `POST /api/hotlead` (tout utilisateur connecté) → `ajouterHotLead` (dédup existante) + annonce Slack + tuile 🔥. **PhantomBuster peut être résilié** (décision Didier en cours) — l'abonnement est à retirer des coûts fixes le jour J.
- **v288 — 📥 import manuel des likers LinkedIn (remplaçant de PhantomBuster) + fix cron veille** : ① le cron /api/veille était rejeté en **401 silencieux** (exigeait Bearer CRON_SECRET, variable absente — seul le bouton manuel marchait) → aligné sur l'en-tête natif `x-vercel-cron` ; diagnostiqué ensuite : cookie li_at des Phantoms expiré (panne classique, remis par Didier). ② PhantomBuster jugé peu fiable/cher → **mode import POST sur /api/veille** (superadmin) : colle le texte brut copié depuis la fenêtre des réactions d'un post (le sien OU un post concurrent — visible par tout membre connecté) ou le JSON du mini-extracteur console (fourni dans la modale) → parsing (bruit LinkedIn filtré, lignes nom/fonction), **même pipeline que PB** : dédup `veille_etat` clé 'import' (alerte dès le 1er import, pas de premierPassage), croisement URL+nom avec les listes en veille → signal 🔥 + Slack, non-matchés → Hot Leads (employés concurrents exclus). Front : bouton « 📥 Importer des likers » + modale dans la carte Veille (Paramètres). La garde « PB manquant » ne bloque plus le POST → **PhantomBuster peut être coupé à l'échéance** (rituel : ~10 min/lundi, posts Sofy + concurrents). Si PB coupé : retirer aussi son abonnement des coûts fixes (onglet Coûts) + le cron 0 */6 devient no-op (inoffensif).
- **🚨 INCIDENT 04-05/08 — CLÔTURE** : restauration liste 50 exécutée depuis la branche Neon `recuperation-alicia` (photo 04/08 ~12:00 UTC) via **`POST /api/restaurer-liste {branch_url, liste_id, dry}`** (superadmin, additive, idempotente — endpoint conservé pour de futurs incidents) : +2 fiches, +6 statuts, +14 contacts, +8 champs → 94 fiches / 93 enrichies / 42 statuées. LIMITES : la rétention Neon = **24 h glissantes** → l'écrasement principal (antérieur au 04/08 midi : le contact Sophie Guinet-Sanchez, présent depuis le 06/07 d'après les traces LinkedIn, manquait déjà dans la photo) est HORS FENÊTRE — les statuts effacés avant le 04/08 midi sont irrécupérables par PITR. Reconstruction manuelle : les NOTES du bloc-notes survivent (table activites, séparée) → Alicia re-statue en s'appuyant sur ses notes ; Sophie = ré-ajouter le contact `s.sanchez@faurie.fr` sur GROUPE FAURIE + 🔵 Lemlist (cache, sans recoût), sa note du 04/08 se raccroche seule par l'email. SÉCURITÉ : mot de passe Neon collé en session — rotation TENTÉE puis annulée par Didier (ancien mdp remis, site re-fonctionnel) → **rotation propre à refaire un jour calme** (reset → DATABASE_URL Vercel → Redeploy, 3 min) ; branches recuperation-* à supprimer. ⚠️ Rappel : la fenêtre PITR de 24 h impose d'agir DANS LA JOURNÉE sur tout futur incident de données.
- **🚨 INCIDENT Alicia 04/08 + FIX : écrasement de liste par onglet périmé (fusion généralisée)** : ~38 fiches enrichies + statuts EFFACÉS sur la liste IA « secteur automobile » (contact Sophie Guinet-Sanchez disparu de la fiche Edouard Guernier alors que sa note bloc-notes subsiste). CAUSE : `persister()` (front) réécrit la liste ENTIÈRE (PUT {id, entreprises}) et le serveur écrasait sans fusion (listes.js:363) — un onglet resté ouvert avec un état antérieur qui fait une action anodine efface tout le travail postérieur (y compris les statuts posés via cockpit, qui écrivent en base mais pas dans le REAL de l'onglet). La protection fusion n'existait que pour Hot Leads. FIX : **fusion généralisée à toutes les listes** dans le PUT complet — une fiche en base absente de l'envoi est conservée (sauf `supprimees` explicite), le statut au `traite_le` le plus récent gagne, `rdv_le/pris_par/lemlist_envoye/sequence_auto/concurrent_perdu/score` préservés, contacts fusionnés par prénom+nom avec complétion email/tél/linkedin. RÉCUPÉRATION des données perdues : Neon point-in-time (branche au timestamp d'avant l'écrasement, console Neon) → réinjecter la colonne entreprises de la liste — étapes données à Didier.
- **Tuiles appels du cockpit : anti-zéro sur échec Ringover (04/08, serveur seul)** : signalement Didier « je n'ai plus les appels passés » puis « c'est apparu après 3-4 min » = rate-limit/latence Ringover (usage API accru : cockpit ×SDR toutes les 2 min + journal + coach-cron + journee-cron). Fix dans `?appels=1` : sur statut ≠ 200 avec 0 appel compté, on sert le DERNIER relevé du jour mémorisé en config (`ring_jour_<sdr>`, stale:true) sinon `appels:null` (le front garde l'affichage précédent — il ignorait déjà null) ; chaque succès est mémorisé. Debug conservé : `?appels=1&debug=1` (superadmin) → statut HTTP/pages/matching.
- **v287 — précision des Insights + tuile Ventes cliquable (audit Didier « Mois dernier »)** : ① AUDIT : les chiffres HubSpot (no-show, ventes, cycle — horodatés à l'entrée de stage), la conversion, le coût/RDV et l'addition conso+abos sont EXACTS ; deux imprécisions corrigées : les **pilules de delta APPELS/JOIGNABILITÉ sont masquées quand la période précédente n'a aucune journée consignée** (`precedent.jours` — « +1057 » vs un juin vide était absurde) et le sous-titre APPELS dit « X jours consignés (journal depuis le 22/07) » — ⚠️ le journal journees_sdr ne couvre juillet qu'à partir du 22/07 (appels/joignabilité/durée partiels sur « Mois dernier ») ; idem « Qualité d'appel 2,6 · 23 analysés » = fin juillet seulement (Coach démarré le 31/07). ② **Tuile 💼 VENTES CONCLUES cliquable** : panneau des deals « Fermé gagné » de la période avec **lien direct vers le deal HubSpot** (`details_gagnes` + `portal_id` via /account-info/v3/details, URL app.hubspot.com/contacts/<portal>/record/0-3/<dealId>).
- **v286 — date de PRISE du RDV figée (`rdv_le`)** : question Didier « pourquoi 2 RDV aujourd'hui alors qu'un date d'hier ? » → `traite_le` est ÉCRASÉ à chaque re-statut : un RDV pris hier mais tagué/re-touché ce matin « migrait » vers aujourd'hui dans Insights (et la tuile Ma journée, qui compte les traces `activites rdv` du bouton 🤝, disait 1 — deux définitions différentes). Fix : `fiche.rdv_le` posé au PREMIER statut « RDV pris » et jamais écrasé (front setStatutAppel + PUT chirurgical listes.js) ; Insights date les RDV sur `rdv_le || traite_le` (fenêtre période + panneau). ⚠️ Les RDV historiques (avant v286) n'ont pas de rdv_le → datés au dernier statut ; exact pour tous les nouveaux.
- **v285 — Lot 2 Gouvernance + KPI ventes HubSpot + fixes Insights (v284 testée OK)** : ① **moteur 🏛️ Gouvernance** (4e radio Verticale) : nom/SIREN de la coopérative → `resoudreHolding` → représentants PERSONNES PHYSIQUES de la coop (rôle = qualite : Président du directoire, membres CS…) → pour chacun, SA société via recherche-dirigeants (anti-homonyme par année de naissance, exclusion holdings/SCI, la plus grosse par CA), 1 fiche/personne, sociétés dédupliquées (2 membres même société = contacts cumulés), `type_fiche:'gouvernance'`, contact = le membre avec « <rôle> — <coop> », détail Pappers + dédup inter-listes au creer, tri CA. ② **Tuiles 💼 VENTES CONCLUES** (deals entrés en « Fermé gagné » sur la période, % des démos planifiées) **et ⏳ CYCLE DE VENTE** (médiane jours entrée Démo planifiée → Fermé gagné, fenêtre 400 j) via /api/noshow (`gagnes`, `taux_vente_pct`, `cycle_median_j`). ③ **Fix tuile RDV ≠ panneau** : la tuile lisait journees_sdr (rempli à 19 h) → RDV/statuées/conversion des tuiles passent en LIVE (scan des fiches, `totaux.rdv/statuees` écrasés + `precedent` recalculé sur la fenêtre précédente) — le journal reste la source de appels/décrochés/durée et de l'onglet Équipe. ④ **RDV du panneau cliquables** → `ouvrirListe(liste_id, cle)` (fiche dépliée v265).
- **v284 — Lot 1 « coopératives » (retour Franck : 334 PDV BigMat inutilisables — il utilisait le moteur 🏪 Enseigne au lieu de 🌐/🏢)** : filtres DÉCIDEURS sur les moteurs société (groupe + web), appliqués à la création : ① champ « **Min. d'établissements par société** » (`vert-minetab` → `b.min_etab`, inconnu = 1) — adhérents multi-sites en priorité ; ② **réseaux intégrés écartés automatiquement** (décision centrale : Adeo/Leroy Merlin/Saint-Gobain/Point P/Rexel/Sonepar/Chausson/Samse… — constante `RESEAUX_INTEGRES_DEFAUT` dans verticale.js, surchargéable via config `reseaux_integres` array) ; ③ **tri par CA décroissant** ; ④ étiquette `type_fiche` : `adherent` (groupe/web → badge « 🏛️ Adhérent / société » via sourceFiche) vs `point_de_vente` (enseigne → « 📍 Point de vente ») ; toasts « 🛡️ Écartés : X réseaux intégrés · Y sous le seuil ». **Lot 2 à faire (validé Didier)** : moteur « Gouvernance » = personnes physiques mandataires de la coopérative (CS/directoire) → leur société adhérente → liste séparée ~20-30 fiches ultra-qualifiées. **Lot 3** : signaux BODACC (nouveau dirigeant/nouvel établissement) en badge. Reco transmise à Franck : 🌐 Annuaire web sur la page adhérents + 🏢 Groupe sur le SIREN de la coop.
- **v283 — ⬇️ Export CSV depuis « Ma journée » (testée OK)** : bouton ⬇️ Export dans l'en-tête du cockpit (à côté de Vue SDR) → `GET /api/export-journee?du=&au=&sdr=` (défaut = aujourd'hui ; SDR forcé à soi-même sauf admin) : les fiches STATUÉES de la période croisées avec les analyses IA (`analyses_appels`, rapprochement par nom de prospect normalisé) et les rappels en attente. Colonnes : Date · Entreprise · Contact · Téléphone · Ville · Liste · Issue d'appel · Décroché (analysé) · Durée · Note IA /10 · Résumé IA · Action recommandée · Next step (RDV pris / Rappel le … / Séquence Lemlist). CSV Excel FR (séparateur `;` + BOM UTF-8), téléchargé en blob via fetch (le lien direct ne porterait pas le Bearer). NB : « Décroché » = un appel analysé par le Coach a matché la fiche (donc décroché ≥ 60 s) — les décrochés courts sans analyse sortent vides.
- **v282 — no-show → rappel auto + camembert territoires + honorés (testée OK, 1er run réel du cron : lendemain 9 h Paris)** : ① `api/noshow-cron.js` (cron **07:00 UTC lun-ven**, `?dry=1` superadmin) : deals entrés en « No show » dans les 25 dernières heures → rapprochement de la fiche par NOM (deal « Société - Produit » → société normalisée, index des fiches taguées RDV) → **rappel auto 14 h chez le SDR** (`traite_par`) avec anti-doublon (pas de 2e rappel « No-show » en attente sur la fiche) + DM Slack « re-booke à chaud » ; introuvables comptés dans la réponse. ② panneau de la tuile 🏆 RDV : **bandeau 📅 planifiées / ✅ honorées / 👻 no-show** (champ `realises` ajouté à /api/noshow = deals entrés en « Démo réalisée ») + **camembert conic-gradient des territoires** (CP des fiches → 971 Guadeloupe / 972 Martinique / 973 Guyane / 974 Réunion / 976 Mayotte / Métropole, `cp` ajouté à rdv_details).
- **v281 — 👻 tuile NO-SHOW branchée sur le pipeline HubSpot (testée OK)** : `api/noshow.js` — mode données (admins) `?du=&au=` : taux = deals ENTRÉS en « No show » ÷ deals ENTRÉS en « Démo planifiée » sur la période (propriétés horodatées `hs_v2_date_entered_<stageId>`, opérateur BETWEEN en ms), stages résolus PAR LIBELLÉ sur les pipelines dont le label commence par « Sales » (Sales - New : noshow id 4981760218 / planifiée `appointmentscheduled` ; Sales - Parc : 5215856847 / 5215856846) + `?debug=1` superadmin (sonde pipelines/stages conservée). Front : tuile 👻 NO-SHOW (chargée en 2e temps après /api/noshow, admins), cliquable → liste des deals passés en No show (panneau partagé avec la tuile RDV via `dataset.mode`). Bonus possible plus tard : rappel SDR auto à chaque passage en No show (cron). ⚠️ le filtre SDR d'Insights ne s'applique PAS au no-show (les deals HubSpot n'ont pas le nom du SDR Sofy Scrap — rapprochement possible par hubspot_owner_id si besoin un jour).
- **v280 — la tuile 🎧 Qualité d'appel s'explique au clic (testée OK ?)** (`stjToggleCoach` → panneau `#stj-coach-detail`, données /api/coach de la période) : pédagogie du barème (sévère, 5 = moyen, les standards/barrages notés 0-2 comptent — comparer période à période et entre SDR), **répartition des notes en 5 tranches colorées**, 🎯 points à travailler (1re action corrective des 5 appels les plus faibles, avec SDR + note), 💬 meilleur appel avec verbatim. **No-show (v281 à venir)** : Didier veut la stat — reco = HubSpot Meetings API (`hs_meeting_outcome` : COMPLETED/NO_SHOW/RESCHEDULED) si les AE y consignent leurs RDV, sinon repli statut AE / DM Slack J+1 one-click ; QUESTION posée à Didier : les AE utilisent-ils les meetings HubSpot avec issue renseignée ?
- **v279 — tuile RDV cliquable + ⚡ speed-to-lead (testée OK ?)** : la tuile 🏆 RDV PRIS se déplie au clic (`stjToggleRdv` → panneau `#stj-rdv-liste` : date · client · ville · SDR — `rdv_details` collectés dans le scan entonnoir, cap 100). Nouvelle tuile ⚡ **SPEED-TO-LEAD** : médiane signal → 1er contact sur les hot leads (`signal.date` vs `pris_le`/`traite_le`, fenêtre 14 j max, affichage min/h) — n'apparaît que s'il y a des hot leads traités sur la période. Reste en réserve : **taux de no-show des RDV** (demande Didier — nécessite un traçage RDV honoré/manqué, ex : statut posé par l'AE ou lecture du calendrier ; à proposer).
- **v278 — 3 tuiles KPI de plus (benchmark SaaS B2B)** : 🎧 **Qualité d'appel** (note Coach moyenne /10 sur la période, delta vs période précédente — `coach_global` + `precedent.coach_note` côté serveur), 🙋 **Taux de proposition** (« ask rate » : % d'appels analysés où un RDV a été explicitement proposé — extrait JSONB `analyse->proposition_rdv->>faite`), ⏱️ **Durée moyenne** par décroché (sparkline via `du` ajouté à `spark`). Grille finale : RDV → Coût/RDV → Conversion → Qualité → Ask rate → Appels → Joignabilité → Durée → Coût.
- **v277 — 📊 « Insights » : refonte complète façon CRM (2e wireframe validé — la v276 jugée trop sommaire, v277 testée OK)** : barre de filtres STICKY avec préréglages **Ce mois · Mois dernier · 7 j · 30 j · Trimestre · 📅 personnalisé** (« Mois dernier » = la réponse à « comment voir le coût du mois dernier ») + sélecteur SDR ; **4 onglets internes** (chips) : ① *Vue d'ensemble* — 6 tuiles KPI carte blanche/ombre avec **pilule de delta colorée** (⬆ vert/⬇ rouge selon la bonne direction, % vs période précédente de même durée) et **sparkline SVG 30 j** par tuile (série `spark` + `spark_cout` ajoutées à /api/stats-journees), graphe activité (barres + 🏆), **entonnoir 4 étages** (statuées → échanges réels → suites → RDV), concurrents ; ② *Équipe* — 1 carte par SDR : avatar initiale colorée, appels/j avec barre vs objectif, joignabilité, RDV, conversion, note Coach, quota Lemlist avec barre, coût — **clic = drill-down** (ses journées jour par jour se déplient sous la carte, remplace le filtre-page v276) ; ③ *Coûts* — 4 tuiles périodisées (total/conso/abos prorata/coût par RDV) + barres par poste + par SDR + accordéon « Référence mensuelle & abonnements » (les 3 anciennes cartes /api/stats y sont conservées : budget réf, abos éditables, limites) ; ④ *Listes* — la carte par-liste existante. Onglets Coûts/Listes masqués pour les non-admins. ⚠️ PIÈGE python heredoc : les `\\uXXXX` écrits dans du HTML restent littéraux (seul le JS les interprète) — décodés en vrais caractères après coup.
- **v276 — 📊 Statistiques refondues en tableau de bord (remplacée le jour même par la v277)** : le filtre Période/SDR pilote désormais TOUT, coûts inclus. `/api/stats-journees` enrichi : `couts` périodisés (conso réelle de la période via consommations.created_at × tarifs, par SDR + par API, **abonnements au prorata** nbJours/30,44), `precedent` (mêmes agrégats sur la période précédente de même durée → deltas), `coach` (note moy/SDR sur la période), `quota` Lemlist live 24 h, RDV par jour dans `graphe`. Front : ① 6 tuiles KPI avec **deltas ▲▼ vs période précédente** (RDV, Coût/RDV, Conversion, Appels, Joignabilité, Coût période — coûts admin only) ; ② graphe barres appels/jour + 🏆 RDV ; ③ tableau ÉQUIPE 1 ligne/SDR (appels/j vs objectif 🟢🟠🔴, joignabilité, RDV, conversion, note Coach, quota Lemlist restant, coût — **clic sur une ligne = filtre la page sur ce SDR**) ; ④ 3 mini-modules côte à côte (🥊 concurrents, 📞 top issues, 💰 coûts par poste) ; ⑤ les gros tableaux (journées jour par jour, détail des coûts, par liste) passés en **accordéons `<details>` repliés**.
- **🎧 Coach d'appels Lot 2 (v275)** : ① le Journal des appels affiche un **badge de note** 🎧 (vert ≥ 7 / orange ≥ 4 / rouge) sur chaque appel analysé (COACH_MAP chargée sur 30 j via /api/coach, `call_id` ajouté au payload ringover-journal), et la **grille complète** (résumé, accroche, découverte, écoute, objections+qualité, proposition RDV, verbatim, 🎯 actions) dans la modale d'écoute (`coachGrilleHtml`, aussi visible depuis la fiche). ② `api/coach-hebdo.js` (cron **vendredi 15:00 UTC ≈ 17 h Paris**, `?dry=1`) : synthèse IA par SDR (pattern n°1 à corriger, point fort, défi mesurable — tutoiement, 120 mots max) en DM + **shadowing** = les 4 meilleurs verbatims gagnants de l'équipe (note ≥ 6) partagés à tous + récap managers (admins slack_id). ⚠️ RH : informer l'équipe que les appels sont analysés (CNIL, finalité coaching) — à inclure dans la note Slack d'annonce.
- **🚨 Incident 03/08 (résolu) — 500 au login après le bump SCHEMA_VERSION 3** : la colonne `analyse` de la nouvelle table = **mot RÉSERVÉ Postgres** (`ANALYSE` = variante de ANALYZE) → « syntax error at or near "analyse" » → la migration crashait à CHAQUE requête (la version en base restait à 2, donc re-tentative infinie → « A server error » partout, login inclus). Fix en 3 temps : ① hotfix retour SCHEMA_VERSION 2 (service rétabli) + table créée paresseusement par `ensureCoach()` (db.js) dans les 2 endpoints coach seulement ; ② handlers coach entièrement sous try/catch (le crash hors-try renvoyait la page HTML Vercel illisible — le `detail` JSON a donné la cause en 1 essai) ; ③ colonne quotée `"analyse"` partout (CREATE + INSERT + SELECT). ⚠️ PIÈGES : tester tout nouveau DDL avant un bump de version (mots réservés !) ; et avant le PROCHAIN bump, ajouter un `pg_advisory_lock` autour de la migration (plusieurs cold starts simultanés la relançaient en parallèle).
- **🎧 Coach d'appels Lot 1 (03/08, serveur — SCHEMA_VERSION 3 → revert 2, table paresseuse)** : analyse IA quotidienne des appels SDR. Étape 0 concluante : **Ringover expose les transcriptions complètes** (`GET /v2/transcriptions`, provider BABEL, `transcription_data.speeches[]` par canal : 0 = SDR, 1 = client, timestamps mot à mot, entités nommées ; match par `call_id` ; sondes conservées : `ringover-journal?debug_appel=1|2`). Table `analyses_appels` (call_id UNIQUE → jamais ré-analysé). `api/coach-cron.js` (cron 04:30 UTC mar-sam, `?dry=1`, `?jour=YYYY-MM-DD` superadmin) : appels sortants décrochés ≥ 60 s de la VEILLE × transcriptions paginées → grille cold-call claude-sonnet-4-6 (note /10 sévère, accroche, découverte, écoute + ratio de parole calculé en JS, objections+réponses+qualité, proposition de RDV explicite, verbatim gagnant, 2 actions correctives, résumé) → ~0,02 €/appel, plafond 60/run. `api/coach.js` GET : `?call_id=` (détail) ou `?du=&au=&sdr=` (liste + moyennes par SDR) — transparence : SDR voit SES analyses, admins tout. Arbitrages Didier : tous les appels ≥ 60 s · transparent · quotidien + coaching hebdo. **Lot 2 à faire** : UI Journal des appels (note + grille au clic), DM coaching hebdo vendredi 17 h (patterns récurrents + shadowing verbatims gagnants équipe), récap manager.
- **v274 — refonte Statistiques (wireframe validé : reco ×3)** : nouvel endpoint `GET /api/stats-journees?du=&au=&sdr=` (journees_sdr + scan des fiches pour l'entonnoir des issues et les pertes `concurrent_perdu` — enfin affichées). Onglet 📊 : filtres Période (Ce mois défaut · 7 j · 30 j · personnalisé) + SDR (admins) ; ① carte ☀️ Journées SDR = tuiles totaux (appels, décrochés %, durée moy, statuées, RDV + % conversion, Coût/RDV admin sur « Ce mois ») + graphe barres appels/jour + tableau jour×SDR avec 🟢🟠🔴 vs objectif d'appels ; ② coûts (cartes existantes) wrappés `#stats-couts` **masqués pour les non-admins** (l'API /api/stats était déjà 403 pour eux — la carte « Par liste » aussi masquée) ; ④ 🥊 pertes par concurrent (barres) ; ⑤ 📞 entonnoir des issues + conversion statuées→RDV. Un SDR voit la page limitée à SES journées (le serveur force user.nom).
- **v273 — rappels et jours ouvrés (testé OK)** : ① le rappel par défaut (« Rappel demandé » fermé sans date) tombe au **prochain jour ouvré 9 h** (plus jamais samedi/dimanche/férié — fériés nationaux calculés, Pâques inclus via Butcher, helpers `feriesFR`/`estJourOuvre`/`prochainJourOuvre`) ; ② **rappels-cron en pause week-end et fériés** (heure de Paris) : les alertes Slack partent le prochain jour ouvré, les rappels restent « en retard » au cockpit — couvre aussi les vieilles re-tentatives J+2 datées un samedi ; ③ rappel manuel posé sur un week-end/férié : autorisé (le SDR a la main) mais toast d'avertissement.
- **v272 — 🚨 RETRAIT de la re-tentative automatique (plainte SDR : rappels perdus)** : la re-tentative auto J+2 (v257) écrasait les rappels MANUELS — l'anti-doublon de /api/taches (« un seul rappel en attente par fiche : on met à jour ») transformait la promesse client d'Alicia en « re-tentative auto », puis sequences-cron comptait 3 tentatives et basculait le lead en séquence Lemlist (gros compte bombardé d'emails pendant une négo). 3 correctifs : ① front — statuts Pas de réponse/Message vocal/Absent ne créent PLUS de tâche (fonction `programmerRetenter` supprimée, ne pas la réintroduire sans clé dédiée par origine) et ne touchent pas aux rappels existants ; ② /api/taches — une tâche « re-tentative auto » ne peut plus écraser un rappel manuel (garde défensive, `preserve:true`) ; ③ sequences-cron — **un rappel EN ATTENTE (quelle que soit la température) = pas de bascule** (avant : garde limitée aux tièdes-rappel). La tuile « À retenter » du cockpit reste (elle draine les re-tentatives déjà créées, puis restera vide). Pour STOPPER une séquence déjà partie : côté Lemlist (campagne → lead → pause/suppression), pas d'API dans l'outil (V2 possible : bouton ⏹).
- **v271 — notes du dépli en entier (testé OK)** : le détail des activités de l'HISTORIQUE du dépli était tronqué à 90 caractères — troncature retirée, zone à 220 px avec ascenseur.
- **v270 — barre de progression du dépli (anti double-clic, testé OK)** : Personas et Compléter affichent une barre animée (`.ck-progress` + `ckProgres(rid,txt|false)`) avec le message d'attente, et un verrou `it._busy` bloque tout relancement sur la même fiche (toast « déjà en cours »).
- **v269 — enrichissement depuis « Ma journée » (testé OK)** (arbitrages Didier : boutons dans le dépli seulement ; Compléter = Lemlist seul, cascade complète en V2) : ① **👥 Personas dans le dépli** — bouton « Chercher les décideurs » quand 0 contact nominatif (cas Sadéco), bouton « 👥 Personas » sinon ; même modale de fonctions (C-level pré-cochés), waterfall Basile → IA de /api/personas, contacts sauvegardés via le PUT chirurgical `{id, fiche_cle, ajouter_contacts:[…]}` (dédup prénom+nom, plafond 8/fiche) puis dépli re-rendu. ② **↻ Compléter (Lemlist ≈0,20 $)** par contact sans email OU sans tél : POST /api/lemlist-enrich + polling pending, résultat persisté via `{id, fiche_cle, contact_enrich:{…}}` (ne remplit que les champs vides). ③ infoFiche expose `nom_officiel/site/linkedin_entreprise` ; l'HISTORIQUE du dépli s'affiche aussi pour les fiches sans email (cles_histo). Le PUT chirurgical renvoie désormais `contacts` + `contacts_ajoutes`.
- **v268 — 🐛 apostrophes dans les onclick (testé OK)** : « Ouvrir la fiche complète » / Statuer / Je prends restaient MUETS sur les fiches à apostrophe (« Ecole des Mines d'Albi Carmaux », « L'instant bistrot ») : `jsArg` = `encodeURIComponent`, qui n'encode PAS l'apostrophe → le `onclick="…decodeURIComponent('…d'Albi…')…"` levait une SyntaxError silencieuse au clic. Fix : `jsArg` encode aussi `'` en `%27` (tous les consommateurs décodent via decodeURIComponent, vérifiés). ⚠️ PIÈGE générique : toute valeur injectée dans un attribut onclick entre quotes simples DOIT passer par jsArg (pas encodeURIComponent nu).
- **Rappels du cockpit : rapprochement fiche renforcé (24/07, serveur seul, testé OK — les 4 rappels d'Alicia résolus)** : un rappel n'était relié à sa fiche (menu Statuer…, téléphone, dépli, « Ouvrir la fiche complète ») QUE si l'email stocké à la création matchait une fiche des listes ACTIVES du SDR — les rappels d'ajouts manuels sans email et ceux de listes passées en nurturing/archivées restaient orphelins (dépli vide, cas École des Mines). Résolution en 3 temps dans api/cockpit.js : email (parEmail) → nom/enseigne normalisés (parNom, listes actives) → la LISTE du rappel elle-même (t.liste_id rechargé, quel que soit son statut). Construction de l'objet fiche factorisée (`infoFiche()`), partagée file principale / rappels.
- **v266-v267 — historique du dépli cockpit complet** : v266 = le dépli interroge /api/activite avec TOUS les emails des contacts (pas seulement l'email principal — la note prise après l'appel d'un autre contact n'apparaissait pas). v267 = les fiches SANS email (ajouts manuels, GMB — cas Eric PIERRE-LOUIS) : la fiche complète journalise sous les clés `clesFiche()` (`siren:…`, `nom:…`) — le serveur cockpit fournit maintenant les mêmes clés (`info.cles_histo`, miroir dans `infoFiche()`) et le dépli les envoie → notes/rappels visibles partout. + champ « Nom du client » de l'Historique : matche aussi les prénom+nom des CONTACTS (« bouton » → arthur bouton), pas seulement la société.
- **Recherche Historique : fin des faux positifs (24/07, serveur seul)** : la requête matchait `entreprises::text ILIKE` = TOUT le JSON — « instant » matchait « en un instant » dans une synthèse/email IA d'une liste sans rapport (BigMat ressortait, puis « Aucune fiche ne correspond » à l'ouverture). La recherche (`q=` et `client=`) ne matche plus que les champs du filtre d'une liste ouverte : nom/enseigne/enseigne_ia/ville/site + contacts (nom, fonction, email, LinkedIn) + téléphones (comparaison par chiffres, jsonb). Le listing SANS recherche garde la requête légère (2 requêtes distinctes). NB comportement voulu (question Didier du 24/07) : les signaux chauds du cockpit suivent le PROPRIÉTAIRE de la liste (une liste transférée alerte le nouveau SDR), et une fiche statuée ré-apparaît si le signal (ex : email ouvert) est postérieur au traitement — relance à chaud.

## Backlog (ordre Didier)

1. **Tableau croisé dynamique pour Romain** (liste × SDR × statut × coût + exports) — en attente de l'arrivée de Romain.
1bis. ~~Liste « lookalike » depuis une fiche~~ → **LIVRÉ en v244** (bouton 👯 Lookalike, voir « Fait le 21-22 juillet »).
2. Couper RB2B une fois Snitcher validé sur de vraies alertes (vérifier le mapping réel via `config('snitcher_last')`).
3. Domaine : passer proprement en www principal (`APP_URL=https://www.sofyscrap.com` + Redeploy), puis ré-enregistrer le hook Lemlist.
4. ~~[Projet séparé] Lemlist : transfert auto des leads non joints → séquences par produit + température~~ → **LIVRÉ en v255** (sequences-cron, voir ci-dessus). Reste en V2 : campagnes « tièdes » dédiées côté Lemlist (8 campagnes au lieu de 4 partagées).
5. Fix `ringover-record` : la regex anti-SSRF n'autorise que `cdn.ringover.com/records/` → 400 sur les URLs `/messages/`.
6. Re-tagging IA des transcriptions Ringover (17 statuts d'appel).
7. SoReach SMS + WhatsApp dans le dashboard ; pagination des fiches.

Admin (côté Didier, à relancer) : Romain → superadmin ; lignes Ringover de chaque SDR dans Paramètres ; liens RDV des AE ; supprimer du repo `basile-debug*`, `basile-geo`, `basile-secteur` ; déployer (optionnel) le `snitcher.js` avec debug.

## 17 août 2026 — Rendement du waterfall d'enrichissement mesuré, puis réordonné (v326-v327)

Question de départ : « utilise-t-on toujours Dropcontact ? ». Nouvel endpoint **`/api/diag-enrich`** (superadmin, lecture seule, bouton dans Paramètres → Maintenance) : croise les **tentatives** (table `consommations`, 1 ligne/appel) avec les **succès réels** (chaque email/mobile porte sa provenance — `email_source`/`tel_source`, ou `source:'dropcontact'` pour le niveau 1).

**Mesure sur 2 mois (12/06 → 17/08) — 2 469 contacts, 67 % avec email, 61 % avec mobile :**

| Étage | Tentatives | Emails | Mobiles | Coût | **€ / donnée obtenue** |
|---|---|---|---|---|---|
| Lemlist *(facturé à la réussite)* | — (423 clics manuels) | 63 | 180 | ~39 € estimés | **0,16 €** |
| Dropcontact | 2 309 | 488 | 391 | 231 € | **0,26 €** |
| FullEnrich | 1 762 | 262 | 463 | 441 € | 0,61 € |
| Kaspr | 1 416 | 66 | 278 | 283 € | 0,82 € |

**Total ~994 € en 2 mois (~450 €/mois) — soit ~2× le coût de l'API Claude (268 $/mois)** qui inquiétait Didier : le vrai poste de dépense était là. 761 emails (46 %) ont été trouvés gratuitement par les SDR eux-mêmes (site web, Google Maps, saisie).

⚠️ **Le taux de réussite seul est un mauvais critère** : le premier verdict codé (seuil « 45 % ») concluait « ⛔ retirer Dropcontact (21 %) », alors qu'il est **le moins cher par donnée**. Corrigé : le verdict classe désormais par **coût d'une donnée obtenue** et signale les étages facturés *à la réussite* (aucun coût d'échec → doivent remonter dans la cascade).

**Décision Didier → v327** : `pipelineFiche()` devient **Dropcontact → 🔵 Lemlist → FullEnrich**.
- Lemlist était le **seul étage non automatisé** alors qu'il est le moins cher et qu'il rendait 243 données sur les cas déjà ratés par les trois autres. En mode auto : `enrichirLemlist(i,j,{max:2,silencieux:true})` (attente courte) ; les résultats tardifs sont récupérés **gratuitement** par `reprendreLemlistEnAttente()` à l'ouverture de la liste.
- **Kaspr sorti du pipeline auto** (283 € pour 278 mobiles, après un FullEnrich qui en trouvait déjà 463). Bouton conservé sur la fiche, tooltip = son coût réel.
- Colonne « 📲 Kaspr » du modal de progression → « 🔵 Lem ».
- **À vérifier au prochain diagnostic** : la couverture mobile (61 %) ne doit pas décrocher. Si elle baisse nettement, remettre Kaspr en dernier étage du pipeline. Reste en réserve : garde-fou « stop après 2 échecs » (280 contacts ont épuisé toute la cascade sans rien rendre ≈ 154 € de perte sèche).

## 17 août 2026 — 📰 Radar : contexte business + accroche BASHO sur les hot leads « visite » (v328-v329)

Demande de **Franck** : quand une entreprise visite sofy.fr, la notification dit *qui*, pas *pourquoi*. Il perdait « plusieurs heures par semaine » à chercher à la main — c'est pourtant cette recherche qui a produit son meilleur hook (*La Grande Récré → refonte CRM Brevo depuis janvier 2026, 12 M d'emails/mois* → « ce dispositif inclut-il le SMS ou le RCS ? »).

**Périmètre : visites du site (Snitcher/RB2B) uniquement**, pas les likers LinkedIn.

- **`api/radar.js`** — Claude + recherche web (`web_search_20260209` avec `blocked_domains` sur les annuaires type pagesjaunes/societe.com qui monopolisent la 1re page ; repli sur les outils 2025). Sortie : signaux typés (9 familles cherchées, dont refonte digitale/CRM, concurrent nommé, ouvertures de points de vente, nouveau dirigeant marketing, offres d'emploi CX), 2 accroches à dire, questions de découverte, **sujets à éviter** (litige, plan social — signalés pour ne pas marcher dessus).
- **`api/radar-cron.js`** — `*/10 7-19 * * 1-5`, 5 entreprises par passage, visites < 48 h non couvertes + complément Slack avec l'accroche. ⚠️ **Volontairement pas dans le webhook Snitcher** : 20-40 s de recherche = timeout côté émetteur et doublons de signaux.
- **Cache `radar_cache` 30 j** (table paresseuse) : une entreprise qui revisite 10 fois ne coûte qu'une fois. Le front lit le cache **gratuitement** ; la recherche payante n'a lieu que sur clic ou via le cron.
- **Front** : bloc « 📰 Contexte business » dans la fiche (sources cliquables + accroche copiable) et version compacte dans le panneau déplié de Ma journée.
- **Modèle** : `MODELE_RADAR` (défaut `claude-opus-5`, `effort: medium`) → bascule sur `claude-sonnet-5` sans redéploiement pour diviser le coût par ~2,5.
- **Coût réel : ~0,15-0,20 € par entreprise** (les recherches web sont facturées 0,01 $ chacune), soit **30-50 €/mois** à 10 visites/jour — l'estimation initiale de 6-10 €/mois était fausse.

**Garde-fou anti-hallucination (non négociable)** : un signal sans **URL source ET date** est rejeté côté serveur, et une accroche dont le signal a été rejeté ne sort pas. Le nombre de pistes écartées est affiché. Une accroche fausse prononcée devant un directeur marketing coûte plus cher que pas d'accroche.

**Garde-fou anti-relance (demande Didier, v329)** : colonnes `echecs`/`dernier_echec`/`motif_echec`/`en_cours_depuis` sur `radar_cache` — verrou 4 min (une seule recherche simultanée par entreprise : 2 SDR, ou SDR + cron), **quarantaine 6 h après 2 échecs** (429 + motif + délai de reprise, bouton grisé côté front), compteur remis à zéro au succès. Chaque sortie en échec est tracée : plus d'échec silencieux.

**Ce que le radar ne peut PAS faire** : lire Facebook et Instagram (contenu derrière authentification, non indexé — Meta n'expose les posts d'une page qu'avec l'accord de son propriétaire). Le radar remonte les **URLs des comptes** pour que le SDR juge en un clic, et déclare dans `non_accessibles` ce qu'il n'a pas pu consulter. Ne jamais promettre l'analyse des réseaux sociaux.

## 19-20 août 2026 — 🎨 Analyse client : base de connaissance + générateur + page publique tracée (v332)

Feature 2 demandée par Didier : accompagner l'email de prospection d'un document **ultra personnalisé** qui donne envie de contacter Sofy. Décision structurante prise avec lui : **page web privée plutôt que PDF** — on sait quand le client l'ouvre, combien de fois et jusqu'où il descend ; le PDF reste disponible via l'impression navigateur.

**`api/kb-sales.js` — base de connaissance.** Table `kb_sales` paresseuse. Amorcée avec **11 blocs** extraits de son deck « Enjeux Visibilité & IA » (19 slides, lues *visuellement* : les slides sont des images, aucun texte extractible) + **2 cas clients** issus des interviews du blog Sofy (Marimax : réponse 30 min → 10-15 min, +30 % sur l'objectif call center, note 3,4 → 4,25, CA doublé · Groupe Kiosque : 436 avis en 6 mois sur 32 points de vente et 4 territoires). `secteur` et `territoire` sont renseignés : c'est ce qui fait servir Marimax à un garage guadeloupéen plutôt qu'un cas au hasard.

**Gouvernance (précision Didier : SDR, AE *et* CMO doivent pouvoir alimenter)** — contribution ouverte, sortie contrôlée : tout utilisateur **propose**, un admin **valide ou refuse avec motif**, et `blocsUtilisables()` ne sert que les blocs validés et non périmés (6 mois). Les types qui engagent l'entreprise (`tarif`, `charte`) restent admin. Un contributeur peut corriger sa proposition tant qu'elle n'est pas validée. **Un chiffre de marché ou un cas client sans source est refusé à la création** — c'est exactement ce que l'IA irait recopier dans un document qui porte le nom de Sofy.

**`api/prez.js` — le générateur.** Compose 7 planches (couverture → constat → coût → solution → preuve → projection → CTA) à partir de tout ce que Sofy Scrap sait déjà du prospect : note Google, **pire fiche nommée**, son **vrai avis négatif cité**, moyenne des concurrents locaux, technos détectées, effectif/CA/établissements, plus les signaux du radar. Règles imposées à l'IA : aucun chiffre sans source, **aucune promesse de résultat** (un cas client se montre, il ne se promet pas), cas client le plus proche en secteur *et* territoire ou aveu franc.

**`api/p.js` — la page du prospect**, sur `/p/<jeton>` (rewrite Vercel, jeton 12 caractères, noindex). Charte du deck : fonds clair/sombre alternés, dégradé violet `#5B4FE9` → rose `#F0428A`, titres géants, chiffres géants avec leur source dessous, révélation au défilement, `@media print` qui repasse les fonds sombres en clair. **Suivi** : compteur d'ouvertures, profondeur de lecture (`sendBeacon`), et à la **première ouverture** une alerte Slack au SDR + une note dans le bloc-notes de la fiche — « ouverte 3 fois » est un signal d'achat plus fort qu'un email ouvert.

**Front** : bouton **🎨 Analyse client** sur chaque fiche. Il existe parce que demander l'« ID de la liste » et une « clé de fiche » à un utilisateur était une mauvaise idée : l'app connaît déjà les deux (`state.savedId` + fiche courante). La confirmation annonce ce que le document va citer, pour que le SDR sache ce qu'il achète.

**Reste à faire** : onglet complet « 🎨 Prez sales » (générateur guidé, éditeur de la base avec file de validation, historique avec compteurs d'ouverture) · ingestion automatique de sources (URL en priorité — sans limite de taille et rafraîchissable ; puis PDF/PPTX/images, plafonnés par la limite de ~4,5 Mo du corps de requête Vercel) · RCS « Découvrez mon analyse Sofy » avec visuel personnalisé.

## 20 août 2026 — 🎨 Analyse client v2 sur les retours Didier (v333)

Retours après lecture du premier site généré : *« trop de texte, pas assez d'animation et de graphique avec progression attendue »*, *« soit plus vendeur »*, *« pour chaque problème analysé proposer une solution et surtout le résultat attendu (cela parle bcp aux grands comptes => permettre de se projeter) »*.

**Structure du document refaite.** Les 7 planches ne racontent plus une histoire linéaire, elles forment un triplet lisible par un décideur : **planche diagnostic** = une carte par problème mesuré (avec son impact chiffré *seulement* s'il découle de ses données) · **planche solution** = une brique Sofy par problème, reliée explicitement via `repond_a` (NAP, store locator, réponse aux avis, collecte SMS/QR/NFC — plus de catalogue décorrélé du diagnostic) · **planche projection** = le graphique qui décide, `actuel` pris dans ses mesures réelles, `cible` justifiée par un cas client ou un chiffre sourcé. Sans valeur actuelle mesurée, l'indicateur est retiré plutôt qu'inventé. Le prompt impose désormais des **longueurs maximales** (titre 65 car., intro 200, point 130, 4 éléments par tableau) : le document balayait mal.

**Animations.** Un site HTML qui ne bouge pas n'avait pas de raison d'être un site : titres révélés mot à mot, cascade sur les cartes, compteurs qui montent jusqu'à leur valeur, barres actuel → visé qui se remplissent à l'entrée dans l'écran. `prefers-reduced-motion` respecté.

**Voile de génération + Stop.** `voileTravail()` bloque toute l'interface pendant les 30-60 s de composition, avec roue, chrono et bouton d'arrêt qui coupe vraiment la requête (`AbortController`, Échap aussi). Sans ce blocage, le SDR relançait ou changeait de fiche pendant la génération — et le document partait sur le mauvais prospect.

**Durée de vie : 15 jours** (`expire_le`, réglable par `PREZ_JOURS_VALIDITE`). Passé ce délai `/p/<jeton>` rend la page « plus disponible » ; `purge-cron` supprime la ligne à J+22 (une semaine de marge pour diagnostiquer si un prospect réclame). Motif double : le stockage Vercel/Neon, et surtout un lien qui traîne finit par montrer au prospect des données périmées.

**Qui lit ? La réponse honnête : on compte, on ne nomme pas.** Nommer un lecteur exigerait de le faire s'identifier, ce qui tuerait le taux d'ouverture. Donc : identifiant aléatoire par appareil (cookie `sl`, **aucune IP, aucune donnée personnelle**) agrégé dans `lecteurs` JSONB → « 3 personnes, 7 ouvertures ». Pour savoir *par où* ça circule, le champ `destinataire` permet un lien par contact (méthode DocSend). Effet de bord le plus utile : **un 2ᵉ lecteur déclenche une alerte Slack distincte** — le prospect a fait circuler le document en interne, c'est le meilleur signal du dispositif.

**Reste à faire** : onglet complet « 🎨 Prez sales » · ingestion de sources (URL puis PDF/PPTX) · RCS « Découvrez mon analyse Sofy » avec visuel personnalisé · **variante « après démo »** (le document est aujourd'hui calibré pour l'amont : le CTA vise l'obtention du RDV ; en aval il faudrait un CTA « prochaine étape » et une planche périmètre/déploiement).

## 20 août 2026 — 🎨 Onglet Prez sales + base de connaissance alimentable (v334-v335)

**L'incident à retenir : « base vide malgré l'amorçage ».** Les 11 blocs du deck existaient bien en base, mais invisibles. Cause : ils avaient été insérés **avant** l'ajout de la gouvernance ; l'`ALTER TABLE ADD COLUMN statut TEXT DEFAULT 'propose'` a rempli les lignes existantes avec ce défaut, et l'amorçage en `ON CONFLICT DO NOTHING` les laissait tels quels. C'est le piège général du pattern « colonne paresseuse avec DEFAULT » : **les lignes déjà là prennent le défaut**, donc un défaut restrictif rend le contenu existant inutilisable en silence. `amorcer()` fait maintenant un UPSERT qui remet `statut`/`actif` à l'état officiel sans écraser titre/contenu/source, et complète `secteur`/`territoire` s'ils sont vides. Second bug trouvé au passage : le seed n'insérait pas `secteur`/`territoire`, donc le choix du cas client « le plus proche » se faisait à l'aveugle.

**Onglet 🎨 Prez sales**, conforme au wireframe du 17/08 : `Générateur` · `Base de connaissance` · `Mes présentations`. Le générateur renvoie vers la fiche (c'est là que sont les mesures) plutôt que de redemander une liste et une clé.

**`api/kb-ingest.js` — trois façons d'alimenter la base sans savoir la structurer** (demande Didier : SDR, AE, CMO, avec « url, faq, pdf etc. ») : une **URL** (Claude la lit via `web_fetch`, sans limite de taille, rafraîchissable en relançant sur la même adresse), un **texte collé**, un **PDF ou une image** (≈2 Mo, limite du corps de requête Vercel ; le `.pptx` n'est pas lisible — le message indique l'export PDF). Claude renvoie des blocs typés, déposés **en proposition** — jamais validés automatiquement, **même proposés par un admin** : ce qui sort d'une lecture automatique se relit avant de partir dans un document au nom de Sofy. Les blocs issus d'un import portent le badge « 🤖 lecture IA ».

**Gouvernance visible** : file de validation en tête de liste (le travail du CMO), badge de blocs en attente dans le menu, « 🕒 à rafraîchir » passé 6 mois, retrait = archivage (`actif = FALSE`) pour garder la trace de ce qui a servi aux documents déjà envoyés.

**Le lien de l'analyse est à deux endroits** : l'encart 🎨 de la fiche (avec ouvertures, lecteurs distincts, jours restants) et une entrée dans le **bloc-notes** à la génération, à côté des appels.

**Reste à faire** : RCS « Découvrez mon analyse Sofy » avec visuel personnalisé · variante « après démo » du document · exclure les visites des utilisateurs Sofy du compteur d'ouvertures (aujourd'hui le clic du SDR sur « 👁 Voir » compte comme une ouverture prospect) · exploiter les decks Partoo pour l'objection « on a déjà Partoo ».

## Pièges connus (ne pas se refaire avoir)

### 🚨 20 août 2026 — Une liste refusée à l'enregistrement = SDR qui travaille dans le vide
Franck génère 30 fiches à 13h18, prend un RDV avec Grokosto, et ne retrouve **ni la liste ni la fiche**. Elle n'a jamais existé en base.

**Trois silences en cascade :**
1. `POST /api/listes` refuse légitimement une création : **nom déjà pris (409)** ou **garde-fou des 3 listes actives enrichies à moins de 50 % (403, SDR seulement)**.
2. Le front avalait le refus — `if(sd.ok)state.savedId=sd.id` puis `catch(_){/* sauvegarde non bloquante */}`. Les fiches s'affichaient, la liste n'existait pas.
3. `persister()` sortait sans rien faire si `savedId` était absent, et `.catch(()=>{})` masquait les échecs de PUT.

**La leçon générale : un refus métier côté serveur doit TOUJOURS remonter à l'écran.** Un `catch` vide sur une sauvegarde est une perte de données différée. Et un garde-fou qui refuse APRÈS une dépense (crédits Pappers) se retourne contre l'utilisateur : le contrôle doit précéder la dépense (`POST { verifier: true }`).

**Ce qui existe maintenant** : contrôle préalable avant génération, persistance avec deux tentatives, bandeau rouge fixe si l'enregistrement échoue, `beforeunload`, indicateur « ✓ enregistré à hh:mm », suffixage automatique des noms en doublon, et enregistrement forcé avant de poser un « RDV pris ». Outil de diagnostic : **Maintenance › 🔎 Où est passée cette fiche ?**

### ⚠️ 20 août 2026 — La CSP de production interdit `blob:` (images refusées en silence)
Le compresseur d'image chargeait les fichiers par `URL.createObjectURL()`. La CSP de `vercel.json` autorise `img-src 'self' data: https:` : **pas `blob:`**. Résultat : « Image illisible » sur *tous* les fichiers déposés, alors que le test local passait sans une erreur.

Deux règles :
1. **Pour décoder un fichier image côté navigateur** : `createImageBitmap(fichier)` (ne passe par aucune URL, donc hors champ de la CSP), avec repli sur `FileReader.readAsDataURL` (`data:` est autorisé). Jamais `createObjectURL` pour un `<img>`.
2. **Tester le front avec les en-têtes de production** : `python3 outils/serveur-test-csp.py` sert `public/` sur le port 8902 en appliquant la CSP lue dans `vercel.json`. Un `http.server` nu n'envoie rien — c'est ce qui a laissé passer le bug. Le bon test vérifie AUSSI que l'ancienne méthode échoue sous cette CSP : sans ça, on ne sait pas si les conditions sont fidèles.

### ⚠️ 20 août 2026 — Une regex invalide dans le script client = document blanc chez le prospect
Trois livraisons de suite ont montré à Didier des planches vides. Le contenu **était rendu** : il
restait à `opacity: 0`. L'animation des titres mot à mot faisait `innerHTML.replace(/(<strong>)?([^<s]+)(</strong>)?(s|$)/g, …)` — le `/` de `</strong>` **ferme l'expression régulière**, le reste devient des drapeaux invalides, `SyntaxError` au parse, et **tout le script de la page meurt**. Les titres restaient visibles (ils ne portent pas `.reveal`), d'où l'illusion de pages vides.

Trois règles qui en découlent, à ne plus jamais enfreindre :
1. **Jamais d'expression régulière sur du HTML** dans le script client. Parcourir les nœuds.
2. **Tout antislash destiné au script client doit être doublé** dans le template littéral de `api/p.js` : `\\s` pour obtenir `\s`. Ici `\s` était devenu `s`, ce qui changeait déjà le sens de la regex.
3. **La visibilité du contenu ne dépend JAMAIS d'une animation.** Les états initiaux invisibles sont conditionnés à la classe `anim` posée par le script sur `<html>` ; sans elle (script cassé, erreur JS, mouvement réduit, ou 6 s écoulées) la page est intégralement lisible. `window.__anim` dit quand la couche est tombée et pourquoi.

**Et surtout, la leçon de méthode** : vérifier la présence des classes dans le HTML rendu ne prouve rien. Il faut (a) `node --check` sur le `<script>` extrait de la page, (b) charger la page dans un vrai navigateur et lire la console. Les trois livraisons ratées venaient de ce trou de test, pas du prompt.

- **Trois façons de faire taire une IA de recherche sans le savoir** (constat radar/Veepee, 17/08 — un e-commerçant très médiatisé rendait zéro signal) : ① **un critère de validation de trop** — exiger l'URL source *et* la date faisait rejeter en silence tous les signaux dont la page n'affichait pas de date ; ne garder comme éliminatoire que ce qui est vraiment indispensable, et signaler le reste au SDR (`date: 'non datée'`). ② **décrire l'ICP dans le prompt** (« enseignes à points de vente ») pousse le modèle à **pré-filtrer par pertinence commerciale** et à écarter des faits réels sur un prospect hors moule ; lui interdire explicitement de juger l'exploitation (`module: null` autorisé). ③ **ne rien forcer** : sans consigne, le modèle peut répondre **de mémoire** sans lancer une seule recherche — il n'a alors aucune source à citer, et le filtre vide tout. Exiger un minimum de recherches et l'interdiction de répondre de mémoire. **Corollaire de méthode : toujours instrumenter avant de régler un prompt** — compter les recherches réellement lancées (blocs `server_tool_use`) et les signaux bruts *avant* filtrage, sinon « n'a rien trouvé » et « n'a pas cherché » sont indiscernables.
- **Un timeout Vercel renvoie du HTML, pas du JSON.** Le radar sur Veepee dépassait les 60 s de la fonction ; Vercel répondait sa page « An error occurred… » et le front faisait `JSON.parse` dessus → `Unexpected token 'A'`, message trompeur « erreur réseau » (17/08). Deux règles : `maxDuration` généreux sur tout endpoint qui fait de la recherche web (300 s), et **jamais de `.json()` nu** sur une réponse pouvant expirer — passer par un `lireJson()` qui lit le texte et reconnaît `FUNCTION_INVOCATION_TIMEOUT` / `An error occurred`.
- **Ne jamais désactiver la réflexion (`thinking`) sur un endpoint qui utilise des outils serveur.** Sur les modèles récents, thinking désactivé fait parfois écrire l'appel d'outil *en texte* dans la réponse : le tour réussit, la recherche ne se lance jamais, aucune erreur n'est levée. Pour réduire le coût ou la latence, baisser `output_config.effort` (`medium`), pas le thinking.

- **Du code affiché dans le HTML doit être ÉCHAPPÉ (`&amp;` `&lt;` `&gt;`)**. Le mini-extracteur de likers vivait en clair dans un `<pre>` : le jour où le script a contenu `uniq<Math.ceil(...)`, le parser HTML a lu `<M` comme une **balise ouvrante** et a avalé silencieusement toute la fin du bloc — 3702 caractères affichés au lieu de 4192, plus le paragraphe suivant absorbé. Aucune erreur, aucun symptôme côté dev : le SDR copiait un script coupé net (`const alerte=(arr.length>2&&uniq`) et n'avait qu'une `SyntaxError` dans sa console (17/08). Un `<` suivi d'une lettre suffit. Contrôle : `document.querySelector('pre').textContent.length` en prod doit égaler la longueur du JS source.
- **Extraction LinkedIn : ne jamais lire le nom depuis un ancêtre du lien.** LinkedIn a supprimé les `<li>` de la fenêtre des réactions ; `a.closest('li')||a.parentElement` remonte alors au conteneur de **toute la liste**, et `innerText.split('\n')[0]` renvoie le nom du **premier** liker pour tous les profils. Symptôme : N URLs distinctes mais un seul nom répété N fois (17/08 : « Guillaume Cavaroc » ×15 → 15 exclusions IA du même profil Meta). Le nom se lit **dans le lien** (texte, `alt` de la photo, `aria-label`, slug de l'URL en dernier recours) ; la fonction dans le plus proche ancêtre ne contenant **qu'un seul** `a[href*="/in/"]`. Le script annonce le nombre de noms distincts et le rapport d'import alerte si un profil domine.
- **Webhooks externes → toujours `www.sofyscrap.com`** (l'apex 308 avale les POST).
- Ringover ne pousse **rien** vers une URL non « Verified » ; son payload réel ≠ doc (voir plus haut) ; la clé sert à **signer** (JWT HS512), elle n'arrive jamais en clair.
- Basile : pas de filtre région/département ni effectif sur `people/find` ; 7 macro-slugs `*_global` seulement ; `FAMILLES_POSTE` figées côté serveur (déterminisme) ; géo fine uniquement via `companies/find` (codes postaux / NAF).
- CSP stricte : **aucune lib externe** dans `public/index.html` (script-src 'self' 'unsafe-inline').
- `listes.entreprises` (JSONB) = source de vérité ; préserver sa forme.
- Secrets : valeurs dans **Vercel → Environment Variables** (27 vars ; `RINGOVER_WEBHOOK_SECRET`, `SNITCHER_WEBHOOK_SECRET`, etc.). Ne jamais les exposer côté client ni les committer.
- Les fiches Hot Lead Snitcher niveau entreprise n'ont pas de personne nommée → les contacts proposés viennent de LinkedIn (personas) : **normal**.
