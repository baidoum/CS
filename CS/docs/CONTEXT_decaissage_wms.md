# Décaissage de palettes — WMS Mobile NetSuite

Fichier de contexte projet. À lire avant toute intervention sur le développement.

---

## 1. Contexte métier

Client agroalimentaire produisant des produits finis palettisés. Chaque palette est
l'unité de manipulation logistique naturelle (réception, rangement, déplacement,
expédition).

**Besoin initial :** pouvoir scanner un numéro de palette unique pour piloter les
mouvements de stock, sans traiter individuellement chaque sous-lot de la palette.

**Constat :** la notion de *License Plate* (LPN) n'existe pas dans le périmètre
NetSuite en place :

- NetSuite WMS : pas de gestion LPN native
- Manufacturing standard (Work Orders & Assemblies) : pas de LPN
- Advanced Manufacturing (*LPN Action*) : module non souscrit
- Solutions complètes de License Plating : uniquement SuiteApps tierces payantes
  (RF-SMART, Nuage, WAERlinx)

Le besoin sort donc du natif et a nécessité un parti pris de modélisation.

---

## 2. Modèle lot / palette retenu

**Le numéro de lot NetSuite porte l'identité de la palette.**

- À la déclaration de production (Work Order Completion), **un seul numéro de lot
  NetSuite est créé par palette**, dont la valeur est le **PALLET ID**
- La quantité du lot = quantité totale de la palette
- La table `customrecord_additionallotdetails` (ALD) est conservée en l'état :
  chaque enregistrement porte un **sous-lot réel** avec ses attributs (vrai numéro
  de lot de production, date de péremption, poids net/brut, SSCC, ligne de
  conditionnement…)
- Chaque ALD conserve le lien sous-lot réel ↔ PALLET ID via
  `custrecord_lots_inventorynumber`

### Règles de gestion associées

| Sujet | Règle |
|---|---|
| Date de péremption | Le lot NetSuite ne portant qu'une date, on retient la **plus proche** parmi les sous-lots. Conforme à la pratique de production actuelle, et conservateur (le FEFO priorise les palettes les plus urgentes). |
| Valorisation | Articles en **coût standard** → les opérations de sortie/ré-entrée sont **neutres en valeur**, pas d'écart de valorisation. |
| Traçabilité fine | Les attributs par sous-lot ne sont plus sur les champs additionnels du numéro de lot : la table ALD devient la source de référence de la composition d'une palette. |

### Contrainte structurante : intégrité de la palette

Le numéro de lot = une palette physique. **Tout mouvement doit porter sur la palette
entière.** Un mouvement partiel laisserait un reliquat ne correspondant à aucune
palette réelle et désynchroniserait le stock du détail ALD.

Toute fraction de palette passe obligatoirement par le **décaissage**.

> **À développer séparément :** un contrôle bloquant interdisant toute transaction
> dont la quantité ne correspond pas à la totalité du lot, hors décaissage
> (User Event sur les transactions de stock). La consigne procédurale seule ne
> suffit pas.

### Alternative écartée

Conserver un numéro de lot par sous-lot réel avec le PALLET ID en simple champ
additionnel : préserve nativement les dates individuelles et le FEFO au sous-lot,
mais **ne permet pas** de manipuler la palette d'un seul scan (chaque mouvement
nécessiterait un développement pour retrouver et déplacer tous les sous-lots).

---

## 3. Le process de décaissage — conception

### Principe

Décaissage **toujours total** : on éclate la palette entière, pas de partiel.
Le bin de destination = bin d'origine (pas de déplacement physique).

### Parcours opérateur (volontairement minimal)

```
Menu WMS > Décaissage
   ↓
Page 1 : scan du numéro de palette (= numéro de lot NetSuite)
   ↓  [Valider]
RESTlet : sortie palette + entrée des sous-lots
   ↓
Page 2 : confirmation
```

Tout le reste est déductible du lot scanné (article, bin, location, quantité), d'où
le choix d'un **scan unique**.

### Transaction utilisée

**Un seul Inventory Adjustment**, deux lignes sur le même article :

- Ligne 1 : `adjustqtyby = -quantité totale`, inventory detail avec
  **`issueinventorynumber`** = lot palette existant
- Ligne 2 : `adjustqtyby = +somme des ALD`, une inventory assignment par ALD avec
  **`receiptinventorynumber`** = nouveau numéro de lot (texte)

> Distinction clé : `issueinventorynumber` pour consommer un lot existant,
> `receiptinventorynumber` pour en créer un nouveau.

Atomique, et neutre en valeur grâce au coût standard.

---

## 4. Configuration WMS mobile

### 4.1 Ce qui est en place et fonctionnel (V1 — à ne pas refaire)

### Process mobile

| Élément | Valeur |
|---|---|
| Process | `AX_DEPALLETISATION` (cloné depuis `NSWMS_BinTransfer`) |
| Parent Application | `NSWMS` |
| Navigation Element Label | `Dépallétisation` |
| First Page | `AX_scanPallet` |
| Roles | Administrator (à étendre) |

### Pages (V1)

| Page | Titre | Éléments |
|---|---|---|
| `AX_scanPallet` | Dépallétisation | `palletTxt` (Text Box, mandatory), `validateBtn` (Action Button) |
| `DEPALLET_CONFIRM` | Décaissage effectué | `OK` (Dynamic Text) |

### Action du bouton (V1)

Action `validate_pall` :

| Champ | Valeur |
|---|---|
| Type | **Submit Form** |
| HTTP Method | POST |
| Script ID | `customscript_ax_wms_test` (à renommer) |
| Deployment ID | `customdeploy_ax_wms_test` (à renommer) |
| Convert Response To Object | coché |
| Loading Text | Dépallétisation en cours… |

### Input Parameters de l'action (V1)

| Key | Value | Rôle |
|---|---|---|
| `page_id` | `constant:custom_page_DEPALLET_CONFIRM` | Page de destination (**obligatoire** pour Submit Form) |
| `palletNumber` | `page:palletTxt` | Valeur scannée transmise au RESTlet |

### 4.2 Cible V2 — récap avant validation + confirmation enrichie (à appliquer manuellement)

Le RESTlet supporte désormais un paramètre `mode` (`preview` / `confirm`, voir section 6). La configuration mobile ci-dessous n'a **pas** été appliquée ni testée depuis ce repo (SCM Mobile ne se déploie pas en SDF) — à construire par petites étapes avec un Update App + vérification à chaque fois, comme le reste de cette section.

```
AX_scanPallet (existant, inchangé)
  → Submit Form (mode=preview, palletNumber=page:palletTxt) → RESTlet
  → Condition sur response:success
      ├─ vrai  → AX_decaissRecap (nouvelle page)
      └─ faux  → AX_decaissErreur (nouvelle page)

AX_decaissRecap (nouvelle page)
  Éléments : Dynamic Text pour item / bin / qtyTotal / nbLots / warnings
             (Output Parameters response:<clé> → state → élément, à valider),
             + un élément (Text Box en lecture seule ou équivalent) pré-rempli
             depuis le state pour re-transmettre palletNumber au second appel.
  Bouton "Confirmer" → Submit Form (mode=confirm, palletNumber=page:<élément ci-dessus>)
    → Condition sur response:success
        ├─ vrai → DEPALLET_CONFIRM (enrichi)
        └─ faux → AX_decaissErreur
  Bouton "Annuler" → retour direct vers AX_scanPallet, aucun appel RESTlet

AX_decaissErreur (nouvelle page)
  Élément Dynamic Text affichant response:message, bouton retour vers AX_scanPallet.

DEPALLET_CONFIRM (existant, à enrichir)
  Ajouter des Dynamic Text pour item / qtyOut / qtyIn / nbLots / adjustmentId
  via Output Parameters (response:<clé> → state → élément), en plus du `OK` existant.
```

**Point non vérifié** : le mécanisme consistant à repousser une valeur du state vers un élément d'une page suivante (pour re-transmettre `palletNumber` sur l'écran de récap) n'a jamais été testé sur ce compte, contrairement au reste de cette section 4 qui est validé. Si "Condition" sur `response:success` n'existe pas tel quel dans cette version de SCM Mobile, replier sur : toujours naviguer vers `AX_decaissRecap` / `DEPALLET_CONFIRM`, avec un élément conditionnellement visible affichant l'erreur à la place du récap normal.

---

## 5. Pièges SCM Mobile — à connaître absolument

Découverts à la dure, à ne pas re-découvrir.

1. **Submit Form exige un Input Parameter `page_id`.** Sans page de destination,
   l'action ne s'exécute pas du tout (aucun log, aucun Loading Text).

2. **Référence de page :** `constant:custom_page_<nom>` pour une page custom,
   `constant:page_<nom>` pour une page standard. Sans le préfixe `custom_page_`
   → « the configured target page does not exist ».

3. **Référence d'élément :** `page:<nom_element>` — **un seul segment**, sans le nom
   de la page, et **sans `getValue()`**. Les noms d'éléments natifs sont juste longs
   (préfixés par leur page), ce qui prête à confusion.

4. **Les Input Parameters arrivent dans `requestBody.params`**, pas à la racine ni
   dans `data`.

5. **Le state n'est pas alimenté par un Submit Form.** C'est **Forward Form** qui
   pousse les données de la page vers le state. Avec une seule page + Submit Form
   direct, `scriptParams` reste vide → lire les valeurs via `page:<element>`.

6. **Distinguer les deux niveaux :** *Page Element* de type `Action Button`
   (le bouton) vs *Mobile Action* de type `Submit Form` (ce que le bouton déclenche).

7. **Update App obligatoire** après chaque modification (process, page, élément,
   action, paramètre). Un Update App en échec peut faire **disparaître le point de
   menu** — développer par petites étapes avec un Update App + vérification à chaque
   fois.

8. **System Rules et langue :** après toute modification de system rule, faire
   `WMS Configuration > Configure Warehouse > Sync System Rules Translations` puis
   `Update App`, sinon la règle ne s'applique pas dans les langues autres que celle
   de configuration.

9. **Debug State :** cocher *Debug State* dans les Mobile Settings affiche les
   paires clé/valeur du state sur les pages mobiles — très utile pour trouver les
   bons chemins.

---

## 6. Le RESTlet — état actuel

Fichier : `ax_wms_rl_decaissage.js` (SuiteScript 2.1, RESTlet)

### Fonctionnement

```
post(requestBody)
  ├── lecture de palletNumber + mode ("preview"|"confirm", défaut "confirm")
  │     dans requestBody.params
  ├── trouverStockPalette()   → SuiteQL : article, location, bin, statut, quantité
  ├── trouverALD()            → ALD actifs (non décaissés) du lot ; message dédié
  │                              si tous les ALD sont déjà décaissés
  ├── validerCoherence()      → contrôles bloquants + avertissements (voir ci-dessous)
  ├── si mode="preview"       → retour du récap, aucune écriture
  ├── creerAjustement()       → Inventory Adjustment (ligne -, ligne +)
  ├── marquerALDDecaisses()   → archivage + traçabilité sur les ALD traités
  └── retour JSON de statut
```

### Requête de stock (validée)

```sql
SELECT inv.id AS invnumid, bal.item AS itemid, bal.location AS locationid,
       bal.binnumber AS binid, bin.binnumber AS bintext,
       bal.inventorystatus AS statusid, bal.quantityonhand AS qty
FROM inventorynumber inv
INNER JOIN inventorybalance bal ON bal.inventorynumber = inv.id
LEFT JOIN bin ON bin.id = bal.binnumber
WHERE inv.inventorynumber = ? AND bal.quantityonhand > 0
```

**Colonnes réelles de `inventorybalance`** (constatées, les noms
`bininventorybalance` / `iteminventorybalance` / `inventorybalance` pointent sur la
même vue) :

```
quantityonhand, quantityavailable, quantitypicked, item, location, binnumber,
inventorynumber, inventorystatus, createddate, lastmodifieddate,
committedqtyperlocation, committedqtyperseriallotnumber,
committedqtyperseriallotnumberlocation
```

### Contrôles en place

Bloquants :
- Aucun numéro de palette reçu → erreur
- Aucun stock disponible → erreur
- Stock sur plusieurs emplacements → erreur (décaissage impossible)
- Stock sans bin → erreur explicite (« ranger la palette avant de la décaisser »)
- Aucun ALD trouvé → erreur
- Tous les ALD déjà décaissés → erreur dédiée, citant l'ajustement d'origine
- Article d'un ALD différent de celui de la palette (quand le champ est renseigné) → erreur
- Numéros de lot ALD dupliqués sur la même palette → erreur
- Somme des quantités ALD ≠ quantité totale de la palette (tolérance 0.001) → erreur

Informatifs (n'empêchent pas le traitement, remontés dans `warnings`) :
- ALD sans numéro de lot ou quantité ≤ 0 → ligne ignorée + log d'erreur
- Numéro de lot ALD déjà présent en stock actif ailleurs pour le même article

### Paramètre de script

| Paramètre | Usage |
|---|---|
| `custscript_ax_decaissage_account` | Compte d'ajustement (List/Record → Account). Si vide, NetSuite utilise le compte par défaut des Accounting Preferences. |

### Retour du RESTlet

```json
// mode="preview"
{
  "success": true, "mode": "preview", "palletNumber": "...", "item": "...",
  "bin": "...", "location": "...", "qtyTotal": 0, "nbLots": 0, "warnings": []
}

// mode="confirm" (défaut si absent)
{
  "success": true, "mode": "confirm", "message": "Décaissage effectué",
  "palletNumber": "...", "bin": "...", "qtyOut": 0, "qtyIn": 0,
  "nbLots": 0, "adjustmentId": "...", "warnings": []
}

// erreur (les deux modes)
{ "success": false, "mode": "preview"|"confirm", "message": "..." }
```

### Statut

**Fonctionnel** — l'ajustement d'inventaire est créé correctement, contrôles de
cohérence et mode `preview` ajoutés (2026-08-14), pas encore testés en conditions
réelles. La configuration WMS Mobile pour exploiter `mode=preview` (écran de récap)
reste à appliquer manuellement — voir section 4.2.

---

## 7. Reste à faire

### Priorité haute

- [x] **Archivage des ALD décaissés** — champs `custrecord_lots_decaisse` /
      `_decaisse_date` / `_decaisse_adjustment` (voir section 8), posés par
      `marquerALDDecaisses()`. **Champs à créer dans NetSuite avant déploiement**,
      pas encore fait à ce stade (2026-08-14).
- [x] **Traçabilité du décaissage** — `custrecord_lots_decaisse_adjustment` pointe
      vers l'Inventory Adjustment, qui relie déjà l'ancien lot (ligne de sortie) et
      les nouveaux (ligne d'entrée) dans ses deux lignes. Pas de champ de
      traçabilité séparé jugé nécessaire.
- [ ] **Renommer le script et le déploiement** (`customscript_ax_wms_test` →
      nom définitif) et mettre à jour l'action mobile en conséquence. Non fait :
      la config WMS Mobile en prod référence l'id actuel, à traiter séparément
      (créer le nouveau script/déploiement, republier l'action, retirer l'ancien).

### Priorité moyenne

- [x] **Contrôles de cohérence côté RESTlet** — écart de quantité ALD/palette,
      doublons de lot, article incohérent (bloquants), lot déjà utilisé ailleurs
      (informatif). Voir section 6.
- [x] **Mode `preview` du RESTlet** — support ajouté pour le récap avant
      validation, sans écriture.
- [ ] **Configuration WMS Mobile du récap + confirmation enrichie** — le RESTlet
      est prêt côté serveur (mode `preview`/`confirm`, champs de réponse enrichis),
      reste à appliquer la config décrite en section 4.2 (nouvelles pages
      `AX_decaissRecap` / `AX_decaissErreur`, Output/Input Parameters, éventuel
      mécanisme "Condition") — non testée, à construire par petites étapes.
- [ ] **Rôles** — étendre les Accessible Roles aux opérateurs entrepôt.

### Priorité basse / à cadrer

- [ ] **Contrôle bloquant des mouvements partiels** sur un lot palette hors
      décaissage (User Event sur les transactions de stock).
- [ ] **Recalcul de la date de péremption du reliquat** — non applicable tant que le
      décaissage reste total, mais nécessaire si un décaissage partiel est
      introduit un jour.
- [ ] **Volumétrie** — surveiller le nombre d'inventory numbers créés (1 par palette
      + N par décaissage).

---

## 8. Référentiel technique

### Table ALD — `customrecord_additionallotdetails`

Champs utilisés par le décaissage :

| Champ | Usage |
|---|---|
| `custrecord_lots_inventorynumber` | Lien vers le numéro de lot palette (clé de rattachement) |
| `custrecord_lots_lotnumber` | **Vrai numéro de lot** → devient le numéro de lot du sous-lot créé |
| `custrecord_lots_netquantity` | Quantité du sous-lot |
| `custrecord_lots_expirationdate` | Date de péremption du sous-lot (format `DD/MM/YYYY`) |
| `custrecord_lots_item` | Contrôle de cohérence : doit correspondre à l'article de la palette (quand renseigné) |

**Champs à créer pour l'archivage/traçabilité** (2026-08-14, pas encore créés dans NetSuite) :

| Champ | Type | Usage |
|---|---|---|
| `custrecord_lots_decaisse` | Check Box | Coché après décaissage réussi de cet ALD |
| `custrecord_lots_decaisse_date` | Date/Time | Horodatage du décaissage |
| `custrecord_lots_decaisse_adjustment` | List/Record → Transaction | L'Inventory Adjustment créé (trace de rappel produit) - lien cliquable direct. `record.submitFields` y écrit l'internal id, comme pour un Free-Form Text : aucun changement de code lié à ce choix de type. |

Autres champs présents (renseignés par le script de déclaration de production) :
`custrecord_lots_location`, `custrecord_lots_relatedwo`,
`custrecord_lots_serializedid`, `custrecord_lots_netweight`,
`custrecord_lots_grossquantity`, `custrecord_lots_packingdate`,
`custrecord_lots_palletid`, `custrecord_lots_pacakagingline`,
`custrecord_lots_batchnumber`, `custrecord_lots_3pllotnumber`,
`custrecord_lots_casecount`, `custrecord_cwgp_lots_ssccbarcode`,
`custrecord_lots_manudate`, `custrecord_lots_memo`, `custrecord_lots_mastertag`,
`custrecord_lots_iscompleted`, `custrecord_lots_status`,
`custrecord_processingerror`, `custrecord_cwgp_addtlerror_logs`,
`custrecord_cwgp_ald_wocomp`, `custrecord_lotdetailsupdated`,
`custrecord_lots_detailsaction`

### Script amont — déclaration de production

Un Map/Reduce existant crée les Work Order Completions à partir des ALD et
alimente les numéros de lot. Points d'attention relevés lors de sa revue :

- Mapping suspect : `custitemnumber_netquantity` reçoit `grossWeight`
- Date d'expiration passée en string brute à `submitFields` (non convertie,
  contrairement au traitement fait sur le WOC)
- Accès non protégé à `vals['custrecord_lots_relatedwo'].value` (crash possible
  avant le contrôle d'absence de WO)
- `getRange(0, 1000)` : plafond dur sur les inventory numbers par WOC

### Environnement

- NetSuite WMS (SuiteApps *SCM Mobile* + *Oracle NetSuite WMS*)
- Advanced Bin / Numbered Inventory Management activé
- Inventory Status activé (statut obligatoire sur les inventory assignments)
- Manufacturing standard (pas d'Advanced Manufacturing)
- Coût standard
- Locations en `Use Bins`
- Impression d'étiquettes via PrintNode (templates Advanced PDF, format 4x6")
