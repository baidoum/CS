# Commande et facturation au poids réel

Documentation fonctionnelle du développement mis en place pour les articles dont le
poids réel par colis peut varier d'un lot de production à l'autre.

---

## 1. Contexte et principe général

Les articles ont pour unité principale le **colis**. Chaque article porte un **poids
par défaut du colis** sur sa fiche article. En temps normal, un colis pèse
approximativement ce poids par défaut — mais l'écart réel (plus ou moins quelques
centaines de grammes selon les lots de production) peut être significatif pour
certains articles, notamment en agroalimentaire.

Pour ces articles, la facturation ne doit pas se baser sur le poids théorique
(nombre de colis × poids par défaut), mais sur le **poids réellement livré**, mesuré
lot par lot lors de la production et rattaché à chaque colis via les ALD (Additional
Lot Details — le détail de traçabilité déjà utilisé par le WMS, voir
`CONTEXT_decaissage_wms.md`).

Ce développement s'applique **uniquement** aux articles explicitement marqués comme
soumis à cette facturation au poids réel — pour tous les autres, rien ne change.

---

## 2. Étape 1 — Identifier les articles concernés

**Où** : fiche article, champ **"Facturation au poids réel"** (case à cocher).

Quand cette case est cochée sur un article, cet article entre dans le circuit
"poids réel" décrit ci-dessous, aux étapes 2 et 3. Pour tout article où elle n'est
pas cochée, la commande et la facturation fonctionnent normalement, sans aucune
intervention de ce développement.

> [Capture d'écran : fiche article, sous-onglet où se trouve la case "Facturation
> au poids réel", avec le champ "Poids par défaut du colis" juste à côté pour
> montrer le lien entre les deux.]

---

## 3. Étape 2 — Saisie de la commande par l'ADV

**Où** : ligne de commande client, nouveau champ **"Poids souhaité"**.

Quand le client commande un article "poids réel" en exprimant sa demande en
kilogrammes (et non en nombre de colis), l'ADV saisit ce poids souhaité directement
sur la ligne. Dès la sortie du champ, la **quantité** (nombre de colis) de la ligne
se calcule et se remplit automatiquement :

```
Quantité (colis) = Poids souhaité ÷ Poids par défaut du colis
                    (arrondi à l'unité supérieure)
```

L'arrondi se fait toujours vers le haut : on ne peut pas commander une fraction de
colis, donc dès qu'un poids souhaité dépasse ne serait-ce que légèrement un multiple
du poids par défaut, un colis supplémentaire est ajouté.

**Cas particulier** : si le poids par défaut du colis n'est pas renseigné sur la
fiche article, un message d'avertissement s'affiche et la quantité n'est **pas**
recalculée — l'ADV doit alors soit compléter la fiche article, soit saisir la
quantité manuellement comme avant ce développement.

> [Capture d'écran : ligne de commande avec le champ "Poids souhaité" rempli et la
> quantité calculée automatiquement à côté.]
>
> [Capture d'écran : le message d'avertissement quand le poids colis de l'article
> n'est pas renseigné.]

---

## 4. Étape 3 — Mise à jour après préparation et livraison

**Déclencheur** : automatique, dès qu'une livraison (Item Fulfillment) est créée
avec les lots renseignés par le préparateur — aucune action manuelle requise.

Pour chaque ligne de la livraison dont l'article est soumis à la facturation au
poids réel, le système :

### 4.1 Retrouve le poids réel livré

Chaque colis expédié correspond à un lot. Deux cas de figure, gérés automatiquement
sans distinction pour l'utilisateur :

- **Le colis a été décaissé individuellement** (voir le développement WMS de
  décaissage de palettes) : son propre poids réel est retrouvé directement.
- **La palette entière a été expédiée sans décaissage** : le système retrouve
  **tous** les colis qui composaient cette palette et additionne leur poids réel
  individuel — le résultat est donc bien le poids réel de l'ensemble expédié, pas
  une approximation.

### 4.2 Cumule le poids sur la ligne de commande

Le poids réel trouvé s'ajoute au champ **"Poids réel livré"** de la ligne de
commande d'origine. C'est un cumul, pas un remplacement : si une commande est
livrée en plusieurs fois, chaque livraison vient s'ajouter aux précédentes, la
ligne de commande reflète toujours le total réellement expédié à date.

### 4.3 Calcule le prix au kg propre à cette commande

Chaque commande peut avoir un prix au colis différent (remises, niveau de prix
client, etc.). Le prix au kg est donc dérivé de **cette commande précise**, pas
d'un prix fixe article :

```
Prix au kg = Prix au colis de la ligne de commande ÷ Poids par défaut du colis (article)
```

Ce prix est enregistré dans le champ **"Prix au kg"** de la ligne de commande, pour
traçabilité et pour le calcul du montant.

### 4.4 Recalcule le montant de la ligne

```
Montant de la ligne = Poids réel livré (cumulé) × Prix au kg
```

Ce montant remplace le montant théorique (calculé sur le nombre de colis commandés)
et c'est lui qui sera repris à la facturation.

> [Capture d'écran : ligne de commande après livraison, montrant "Poids réel
> livré", "Prix au kg" et le montant recalculé de la ligne.]

---

## 5. Point de vigilance

Le **prix unitaire au colis** affiché sur la ligne de commande (`rate`) n'est **pas**
recalculé par ce développement — il reste celui saisi/négocié au moment de la
commande. Seul le **montant** de la ligne change, pour refléter le poids réellement
livré. Il en résulte que prix unitaire × quantité ne redonne plus exactement le
montant de la ligne après passage de ce script — c'est un choix assumé (le prix au
colis garde son sens commercial d'origine), à prendre en compte dans les gabarits
d'impression de commande/facture si le rapprochement visuel prix × quantité =
montant y est attendu.

---

## 6. Sécurité des données

Si, pour un colis expédié, aucune information de poids réel (ALD) n'est retrouvée
dans le système, **la ligne de commande correspondante n'est pas mise à jour du
tout** — ni le poids, ni le prix au kg, ni le montant. Le système ne produit jamais
un montant à zéro ou approximatif faute de donnée : soit la donnée réelle est là et
le calcul se fait, soit rien n'est modifié et l'anomalie reste visible dans le
journal technique pour investigation.

---

## 7. Récapitulatif des champs

| Champ | Emplacement | Rôle |
|---|---|---|
| Facturation au poids réel | Article | Active le circuit "poids réel" pour cet article (étapes 2 et 3) |
| Poids par défaut du colis | Article | Poids théorique d'un colis, sert au calcul de la quantité (étape 2) et du prix au kg (étape 3) |
| Poids souhaité | Ligne de commande | Saisi par l'ADV, calcule automatiquement la quantité de colis |
| Poids réel livré | Ligne de commande | Cumul du poids réellement expédié, mis à jour à chaque livraison |
| Prix au kg | Ligne de commande | Dérivé du prix au colis de cette commande, utilisé pour le montant final |
