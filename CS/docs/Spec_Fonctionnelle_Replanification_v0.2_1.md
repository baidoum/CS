# Spécification fonctionnelle — Séquencement et fractionnement des ordres de fabrication

**Version** 0.2
**Environnement de référence** Compte sandbox 8082832-sb1
**Supply Plan Definition** 729922 — horizon 180 jours, Generate Pegging activé
**Planning Rule Group** H --> A --> D · **Planning Item Group** 729922
**Planning Workbench View** Cuisine solutions PF

| Version | Évolution |
|---------|-----------|
| 0.1 | Principe de travail sur les commandes planifiées. Comportements validés du moteur. |
| 0.2 | Séquencement descendant par niveau, arbitrages en attente de recalcul, verrouillage pendant le calcul, codification des niveaux par le code article, composants en lecture d'information. Annexes A (design), B (architecture technique) et C (organisation du projet). |

---

## 1. Objet

Définir le principe fonctionnel permettant au planificateur de fractionner et de replanifier une production multi-niveau, en quantités et en dates, sans intervention manuelle niveau par niveau sur chaque article.

## 2. Problème à résoudre

Le MRP propose une quantité unique à une date unique pour un produit fini. Le planificateur doit pouvoir répartir cette quantité sur plusieurs jours selon la capacité réelle de production, et l'ensemble des niveaux inférieurs de la nomenclature doit rester cohérent avec cette répartition.

## 3. Principe retenu

**Toutes les décisions se prennent sur les commandes planifiées, avant création des ordres de fabrication. Le moteur MRP assure la propagation vers les niveaux inférieurs. Le traitement s'effectue par niveau de nomenclature complet, du plus haut vers le plus bas, avec un recalcul entre chaque niveau.**

Aucun développement de cascade de nomenclature n'est nécessaire : ni calcul de ratio composant, ni gestion des tailles de lot, ni récursion multi-niveaux.

---

## 4. Comportements validés

### 4.1 Éclatement multi-niveau depuis la demande

Le lancement du MRP sur la base d'une commande client génère les commandes planifiées du produit fini et de l'ensemble de ses niveaux inférieurs, dates décalées des délais.

### 4.2 Stabilité des commandes planifiées firmées

Une commande planifiée firmée n'est ni modifiée ni supprimée par une relance du MRP. Ses quantités et ses dates sont conservées.

### 4.3 Pilotage des niveaux inférieurs par une commande firmée

Test réalisé : une commande planifiée de 10 pièces a été remplacée par 5 commandes de 2 pièces à des dates échelonnées, puis firmées ; le MRP a été relancé.

Résultat : la décomposition a été conservée, et le moteur a régénéré les commandes planifiées des semi-finis en fonction des nouvelles quantités et des nouvelles dates.

**Conséquence : le fractionnement au niveau supérieur suffit à repositionner tous les niveaux inférieurs.**

### 4.4 Modification d'un seul niveau à la fois

Le déplacement de la date d'un semi-fini, sans toucher à ses propres composants, est correctement traité : le moteur repositionne la descendance.

Le déplacement simultané d'un semi-fini **et** de ses composants produit des commandes planifiées en doublon sur le semi-fini.

### 4.5 Deux opérations distinctes, et une attente

Le moteur travaille sur le référentiel de planification, alimenté par les données **transactionnelles** : commandes clients, commandes fournisseurs, ordres de transfert, stock, nomenclatures, paramètres article et emplacement. Les commandes planifiées n'en font pas partie : elles appartiennent au monde de la planification, non aux transactions.

D'où deux cas à ne pas confondre :

| Ce qui a changé | Opération nécessaire |
|-----------------|---------------------|
| Des commandes planifiées, uniquement (arbitrages du planificateur) | Lancement du calcul seul |
| La demande ou les données article (commande client, stock, nomenclature) | Actualisation du référentiel, puis lancement |

Le lancement seul sur des données non actualisées recalcule à partir d'une photographie périmée : c'est ce qui explique qu'une commande client récente reste invisible du moteur.

Ce traitement est mis en file d'attente : il écrit les propositions en base sans retour exploitable immédiat. L'écran ne peut ni afficher le résultat dans la continuité du clic, ni savoir a priori combien de temps l'attente durera — d'où les exigences F7 (verrouillage) et F8 (composants datés).

### 4.6 Absence de propagation sur les ordres de fabrication réels

NetSuite ne propage aucune modification d'un OF parent vers ses OF enfants, ni en quantité ni en date. Chaque OF est une transaction indépendante ; le lien parent/enfant sert à la génération initiale, pas à la maintenance.

Les vues d'ordonnancement graphiques natives (Manufacturing Scheduler, Gantt) opèrent au niveau des tâches d'opération et ne portent aucune dépendance entre ordres de fabrication distincts.

---

## 5. Codification des niveaux

Le niveau de nomenclature est porté par le premier caractère du code article.

| Préfixe | Niveau | Nature | Traitement dans l'outil |
|---------|--------|--------|------------------------|
| 7 | Produits finis | Fabriqué | Arbitrable |
| 5 | Semi-finis | Fabriqué | Arbitrable |
| 3 | Préparations | Fabriqué | Arbitrable |
| 1 | Matières premières | Acheté | Consultation seule |

Les articles de préfixe 1 génèrent des propositions d'ordre d'achat. Le fractionnement n'a pas le même sens sur un approvisionnement externe : il relève de la négociation fournisseur et n'est pas traité par cet outil.

**Contrainte de conception** : la correspondance préfixe / niveau est une convention de codification, pas une contrainte système. Elle doit être portée par un paramètre modifiable et non codée en dur. Un code de préfixe inconnu doit apparaître dans un groupe distinct, jamais être masqué silencieusement.

---

## 6. Règles de gestion

| N° | Règle |
|----|-------|
| RG1 | Le fractionnement et la replanification s'effectuent exclusivement sur les commandes planifiées, avant création des ordres de fabrication. |
| RG2 | Les ordres de fabrication ne sont créés qu'une fois le plan validé et firmé sur l'ensemble des niveaux concernés. |
| RG3 | Un seul niveau de nomenclature est arbitré par cycle. Les composants ne sont jamais ajustés dans le même cycle que l'article qui les consomme. |
| RG4 | Un cycle d'arbitrage porte sur tous les articles d'un même niveau. Le recalcul est déclenché une fois pour le niveau entier, jamais article par article. |
| RG5 | Toute modification de commande planifiée doit être suivie d'un recalcul du plan pour que les niveaux inférieurs soient régénérés. |
| RG6 | L'écran est indisponible pendant l'exécution d'un recalcul. Aucune modification ni aucun nouveau lancement n'est possible durant ce temps. |
| RG7 | Le firmage est un renoncement à la replanification automatique. Il est appliqué le plus tard possible et sur l'horizon le plus court possible. |
| RG8 | Aucune modification de quantité n'est effectuée après création des ordres de fabrication. Un changement de quantité impose de repasser par le plan. |

RG3 est garantie par construction : le séquencement descendant fait qu'un niveau et sa descendance ne sont jamais modifiables dans le même cycle. Aucun contrôle applicatif n'est nécessaire.

---

## 7. Processus cible

1. **Saisie de la demande** — commande client enregistrée.
2. **Calcul initial** — actualisation du référentiel de planification, puis lancement du plan 729922. C'est la seule étape du processus qui requiert une actualisation, la demande commerciale ayant évolué. Les propositions sont générées sur tous les niveaux.
3. **Arbitrage du niveau 7** — le planificateur parcourt les produits finis présentant des propositions et fractionne les quantités selon la capacité de production. Chaque arbitrage validé est enregistré et firmé immédiatement ; seule sa propagation vers les niveaux inférieurs reste en attente du recalcul.
4. **Relance du calcul** — déclenchée une fois pour l'ensemble du niveau, sans actualisation du référentiel. L'écran est verrouillé pendant le traitement. Le moteur régénère les propositions du niveau 5 en fonction des décisions firmées.
5. **Arbitrage du niveau 5**, puis recalcul. **Arbitrage du niveau 3**, puis recalcul.
6. **Vérification** — les propositions de tous les niveaux sont cohérentes et firmées.
7. **Création des ordres de fabrication** — une seule fois, sur un plan entièrement validé.

Le nombre de cycles est égal au nombre de niveaux à arbitrer, soit deux à trois par session, et non au nombre d'articles traités.

---

## 8. Besoins fonctionnels

### F1 — Sélection de l'article
Recherche par code ou désignation, avec regroupement par niveau de nomenclature. Chaque article indique le nombre de propositions en attente d'arbitrage, ce qui fait du sélecteur la file de travail du planificateur. Les articles achetés sont identifiés comme tels.

### F2 — Consultation des propositions
Affichage des commandes planifiées de l'article sélectionné : quantité, dates, statut de firmage. Distinction visuelle entre les propositions issues du calcul et les décisions firmées par le planificateur.

### F3 — Fractionnement
Trois méthodes de répartition, au choix du planificateur :

- **quantité journalière** — lignes de quantité fixe à partir d'une date de début ;
- **nombre de lots** — n lignes de quantité égale ;
- **saisie libre** — le planificateur ajoute, modifie et supprime autant de lignes qu'il le souhaite, chacune avec sa date et sa quantité propres, sans contrainte de régularité ni d'espacement.

Les deux premières méthodes ne sont que des amorces : leur résultat doit rester modifiable ligne à ligne avant validation. Un planificateur qui produit 2 par jour sauf le vendredi où il en fait 4 doit obtenir ce résultat sans repartir de zéro.

L'option jours ouvrés s'applique aux méthodes automatiques.

Prévisualisation systématique avant validation. À la validation, la proposition d'origine est remplacée par les commandes planifiées résultantes, firmées.

**Contrôle des quantités**

Comparaison permanente entre le total réparti et la quantité d'origine. **Aucun écart n'est bloquant** : le planificateur est seul décideur et l'outil ne doit pas se substituer à son jugement. L'écart est qualifié et tracé.

| Situation | Traitement |
|-----------|-----------|
| Total égal à la quantité d'origine | Aucun signalement. |
| Total inférieur | Signalement informatif. Le besoin non couvert sera régénéré par le moteur au prochain recalcul, sous la forme d'une proposition complémentaire. |
| Total supérieur | Signalement permanent et visible tant que l'écart subsiste, mentionné au journal des interventions lors de la validation. Il s'agit d'un sur-approvisionnement, dont le signalement par le moteur n'est pas établi (section 10) : la trace applicative est le seul moyen de le retrouver a posteriori. |

**Contrôle des dates**

Signalement informatif, non bloquant, d'une date antérieure à la date du jour ou sortant de l'horizon de planification. Une date trop précoce peut rendre la chaîne d'approvisionnement infaisable et conduire le moteur à replanifier l'article, produisant une proposition en doublon (comportement observé en 4.4). Le planificateur reste libre de valider.

**Précision des quantités**

Le nombre de décimales autorisé doit suivre l'unité de mesure de l'article. À préciser avec le client.

### F4 — Arbitrages en attente de recalcul
Décompte permanent des articles arbitrés depuis le dernier recalcul.

**Ce qui est en attente.** Chaque arbitrage validé est enregistré immédiatement : les commandes planifiées firmées existent en base dès la validation. Il ne s'agit donc pas de modifications retenues en attente d'enregistrement. Ce qui reste en attente, c'est uniquement la **propagation vers les niveaux inférieurs**, qui n'a lieu qu'au recalcul.

**À quoi sert le compteur.** D'une part à rendre visible ce qui a été traité dans le cycle en cours, puisque RG4 prévoit d'arbitrer plusieurs articles avant de ne recalculer qu'une fois. D'autre part à piloter la commande de recalcul, grisée lorsqu'aucun arbitrage n'est en attente.

**Risque couvert.** Le planificateur répartit les 10 pièces d'un produit fini sur 5 jours à partir du 1er septembre, puis quitte l'écran sans recalculer. Ses décisions sont enregistrées, mais les propositions des semi-finis restent positionnées d'après l'ancienne date de production. Aucun mécanisme ne signale l'incohérence : elle se découvre lorsque le semi-fini manque en production. Le compteur rend cet oubli difficile.

Une confirmation à la sortie de l'écran lorsque des arbitrages sont en attente compléterait le dispositif — à trancher.

### F5 — Indicateur de séquencement
Affichage des niveaux comportant encore des propositions non arbitrées. L'outil porte ainsi le processus au lieu de reposer sur la mémoire de l'utilisateur.

### F6 — Lancement du calcul
Déclenchement du lancement de la Supply Plan Definition depuis l'écran. Les arbitrages portant exclusivement sur des commandes planifiées, **aucune actualisation du référentiel n'est requise entre deux cycles de niveau** (voir 4.5).

L'actualisation du référentiel reste nécessaire pour prendre en compte les évolutions de la demande, mais elle ne relève pas du cycle d'arbitrage : elle est traitée comme une opération périodique, planifiée quotidiennement ou déclenchée en début de session. Lorsqu'elle est nécessaire, privilégier le mode **Net-Change** et le périmètre **Scoped** afin de limiter la durée du traitement.

Libellé retenu : **Relancer le calcul** — le planificateur demande un recalcul, il ne lance pas un moteur.

Conséquence favorable : la durée du verrouillage F7 s'en trouve réduite, le lancement seul étant plus rapide qu'un enchaînement actualisation puis lancement.

### F7 — Verrouillage pendant le traitement
Pendant l'exécution, l'écran est indisponible, avec indication de l'auteur du lancement et de l'heure de départ.

Exigences :
- l'état de verrouillage doit être déterminé d'après l'état réel du traitement, et non d'après un indicateur propre à l'outil : un lancement effectué depuis l'écran standard de la Supply Plan Definition doit également verrouiller l'outil ;
- expiration automatique du verrou et déverrouillage manuel par un administrateur, afin qu'un traitement en échec ne bloque pas l'écran indéfiniment.

### F8 — Composants en information
Affichage en lecture seule des propositions des composants directs de l'article sélectionné, avec mention explicite de la date du calcul dont elles sont issues. Traitement visuel volontairement secondaire par rapport aux propositions de l'article.

Cette zone n'est pas modifiable : elle ferme la boucle de retour en montrant au planificateur que son arbitrage a produit un effet, sans laisser croire que l'outil calcule lui-même l'éclatement.

### F9 — Journal des interventions
Horodatage, utilisateur, opération, article concerné, proposition d'origine et commandes créées.

---

## 9. Contraintes techniques établies

| Élément | Constat |
|---------|---------|
| Record `plannedorder` | Scriptable côté serveur et client. Création, lecture, mise à jour, suppression et recherche possibles. Copie et transformation non supportées. |
| Prérequis | Fonctionnalité Material Requirements Planning activée (Setup > Company > Enable Features > Items & Inventory). |
| Paramètres d'initialisation obligatoires | `supplyplandefinition`, `supplyplanningrun`, et `firmed` obligatoirement à `T` — une commande planifiée créée manuellement ne peut pas être non firmée. |
| Valeurs de `transactiontype` | `TrnfrOrd`, `WorkOrd`, `PurchOrd`. |
| Rattachement | Une commande planifiée créée par script se rattache à une Supply Plan Definition et à un run de planification existants. |
| Lecture des propositions | Opération distincte du lancement du calcul, à effectuer après achèvement du traitement de fond. |

---

## 10. Points à trancher

### Bloquants pour le chiffrage

- **Durée réelle d'un lancement de calcul, sans actualisation du référentiel.** Elle détermine la viabilité du modèle : le verrouillage rend l'écran indisponible pendant tout le traitement. À mesurer séparément de la durée d'une actualisation, qui sort du cycle d'arbitrage.
- **Identification des propositions des composants (F8).** Deux sources possibles : le pegging, activé sur la définition 729922, qui porte le rattachement offre/demande calculé par le moteur ; ou la nomenclature, qui impose de filtrer les commandes planifiées par article, emplacement et fenêtre de dates — méthode inexacte dès qu'un semi-fini est partagé entre plusieurs produits finis, cas courant en agroalimentaire.
- **Déclenchement du lancement du calcul par script (F6).** Faisabilité à établir. À défaut, l'outil redirige vers l'écran standard de la Supply Plan Definition.
- **Nécessité d'une actualisation du référentiel après modification de commandes planifiées.** À confirmer par un lancement sans actualisation préalable : les niveaux inférieurs doivent se régénérer. Le modèle décrit en 4.5 et F6 repose sur ce point.
- **Numérotation du run de planification.** Une commande planifiée firmée conserve-t-elle le numéro de run de sa création, ou est-elle réestampillée au run courant ? La réponse détermine la requête de lecture de l'écran : un filtre sur le dernier run ferait disparaître des commandes actives si elles conservent l'ancien numéro.
- **Détection de l'état du traitement (F7).** Moyen de connaître l'exécution en cours, y compris lancée hors de l'outil.

### Non testés

- **Comportement des commandes planifiées firmées lors d'un Complete Refresh.** Les comportements de la section 4 ont été validés hors refresh complet.
- **Comportement en cas de modification de la demande d'origine** — évolution ou annulation d'une commande client après firmage.
- **Signalement du sur-approvisionnement** — le moteur produit-il une exception ou une recommandation lorsque des commandes firmées excèdent le besoin ?
- **Création des ordres de fabrication depuis le plan validé** — modalités de création groupée, et risque de double génération d'OF sur les niveaux inférieurs.
- **Création de commandes planifiées par script** — équivalence de comportement avec une création réalisée depuis le Planning Workbench.
- **Gestion des modifications après création des ordres de fabrication.**

---

# Annexe A — Système de design de la maquette

Cette annexe documente les choix de la maquette HTML (`Maquette_Fractionnement.html`) afin qu'ils soient reproduits volontairement, ou écartés en connaissance de cause.

## A.1 Principe directeur

**La couleur encode l'origine de la décision, pas la gravité.** C'est le seul axe sémantique de la palette :

| Axe | Signification | Usage |
|-----|---------------|-------|
| Ocre | Décidé par le planificateur, firmé | Lignes arbitrées, panneau de répartition, pastille « Firmé » |
| Pétrole | Calculé par le moteur | Propositions non firmées, zone composants, messages informatifs |
| Rouge brique | Écart nécessitant une trace | Sur-approvisionnement, date invalide |
| Ardoise | Habillage, chrome, titres | Barre supérieure, filets de section |

Ce codage porte le message central de la solution — qui décide quoi — et répond visuellement à la question que le client posera. Il ne doit pas être détourné pour signifier autre chose (statut, priorité, urgence).

## A.2 Jetons de couleur

| Jeton | Valeur | Rôle |
|-------|--------|------|
| `--slate` | `#44597a` | Barre supérieure, filets de section |
| `--slate-dk` | `#33445d` | Texte sur fond clair du bandeau |
| `--ns-blue` | `#1f6fd0` | Action principale, focus |
| `--ns-blue-dk` | `#175aad` | Survol action principale |
| `--human` | `#b1701a` | Décision du planificateur |
| `--human-bg` | `#fdf6e9` | Fond du panneau de répartition |
| `--human-br` | `#e3c9a0` | Bordures associées |
| `--engine` | `#0f6e6e` | Calcul du moteur |
| `--engine-bg` | `#eef6f6` | Fond des pastilles et messages |
| `--engine-br` | `#b8d6d6` | Bordures associées |
| `--alert` | `#a8322d` | Écart tracé |
| `--alert-bg` | `#fbeceb` | Fond des signalements |
| `--ink` / `--ink-2` / `--ink-3` | `#1c2430` / `#5a6675` / `#8a95a3` | Texte principal, secondaire, tertiaire |
| `--rule` / `--rule-lt` | `#d7dce3` / `#e8ecf1` | Filets, séparateurs de lignes |
| Fond de page | `#eaedf1` | — |
| En-têtes de tableau | `#dfe4ea` | — |

Les teintes d'habillage sont volontairement proches du vocabulaire visuel de NetSuite, afin que l'écran soit perçu comme faisant partie de l'ERP et non comme un outil étranger.

## A.3 Typographie

- **IBM Plex Sans** — interface, poids 400 / 500 / 600 / 700. Cohérence avec les autres outils internes développés sur ce compte.
- **IBM Plex Mono** — toutes les données : codes articles, quantités, dates, horodatages. Avec `font-variant-numeric: tabular-nums`, indispensable pour que les colonnes de quantités s'alignent.
- Corps de base 13 px. Libellés de champ en 10 à 11 px, capitales, interlettrage 0.07 à 0.09 em.

**Contrainte de mise en œuvre** : ne pas dépendre d'un CDN de polices depuis un Suitelet. Charger les fichiers `woff2` dans le File Cabinet et les servir depuis là, avec repli sur les polices système (`-apple-system, Segoe UI, sans-serif` et `ui-monospace, Menlo, monospace`).

## A.4 Structure de l'écran

L'ordre des zones porte le processus et ne doit pas être réarrangé :

1. **Barre supérieure** — situe l'écran dans l'ERP, et porte le bandeau d'avertissement en maquette.
2. **État du plan** — dernier calcul, arbitrages en attente, niveaux restants, commande de relance. En haut car elle conditionne la lecture de tout le reste.
3. **Sélecteur d'article** — point d'entrée, groupé par niveau.
4. **Contexte** — article, niveau, emplacement, plan, horizon.
5. **Légende sémantique** — explicite le codage couleur. À conserver : elle désamorce la question de la responsabilité des décisions.
6. **Propositions de l'article** — zone de travail principale.
7. **Panneau de répartition** — déplié à la sélection d'une ligne, jamais affiché à vide.
8. **Composants pour information** — traitement visuel atténué, horodaté.
9. **Journal**.

## A.5 États et signalements

| État | Traitement visuel |
|------|-------------------|
| Écran sans article sélectionné | Zone d'invitation expliquant la codification des niveaux, et non un message d'erreur |
| Article sans proposition | Ligne de tableau en italique grisé, pas de zone vide |
| Article acheté | Panneau de répartition masqué, note explicative |
| Total inférieur à l'origine | Message pétrole, informatif |
| Total supérieur à l'origine | Message rouge brique, permanent tant que l'écart subsiste |
| Date passée, hors horizon, ou week-end | Observation en regard de la ligne concernée |
| Calcul en cours | Verrou plein écran, auteur et heure du lancement, progression |

Aucun de ces états n'est bloquant, conformément à F3.

## A.6 Accessibilité

Éléments implémentés dans la maquette, à reprendre :

- combobox avec `role="combobox"`, `aria-expanded`, `aria-controls`, navigation flèches / Entrée / Échap ;
- `:focus-visible` visible sur tous les éléments interactifs ;
- libellés `aria-label` sur les contrôles de ligne, numérotés ;
- verrou en `role="alertdialog"` avec `aria-live="assertive"` ;
- `@media (prefers-reduced-motion: reduce)` neutralisant les transitions ;
- contrastes de texte conformes sur fonds clairs.

---

# Annexe B — Architecture technique recommandée

Les éléments de cette annexe sont des **recommandations**, à valider en conception détaillée. Ce qui relève d'un constat est signalé comme tel.

## B.1 Type d'écran — décision : HTML complet, `serverWidget` écarté

**Décision d'architecture.** L'écran d'arbitrage est un Suitelet qui écrit son propre HTML et sa propre feuille de style. L'approche `N/ui/serverWidget` est **écartée**, et ne doit pas être reproposée en conception détaillée.

Motifs du rejet, rapportés aux exigences :

| Exigence | Pourquoi `serverWidget` ne convient pas |
|----------|----------------------------------------|
| F3 — lignes éditables, total recalculé en direct | Une sous-liste, même en `INLINEEDITOR`, n'offre pas d'ajout et de suppression libres de lignes ni de total recalculé à la frappe sans aller-retour serveur. |
| F3 — observation par ligne (date passée, hors horizon, week-end) | Pas de colonne d'annotation libre exprimable au niveau ligne. |
| F7 — verrou plein écran | Non réalisable sur un formulaire natif. |
| A.1 — codage couleur sémantique par ligne | Le rendu des sous-listes n'est pas contrôlable à ce niveau. Le message central de la solution serait perdu. |
| Fluidité de la saisie libre | Chaque interaction sur un formulaire natif implique un rechargement, incompatible avec la souplesse voulue. |

Bénéfice complémentaire : la maquette devient la base réelle du développement front, au lieu d'être jetée après validation.

**Responsabilités transférées au développement**, qui étaient assurées par `serverWidget` :

- **Échappement systématique** de toute donnée injectée dans le HTML — désignations d'articles, libellés d'emplacement, entrées de journal. Une désignation contenant un chevron ou une apostrophe ne doit jamais pouvoir altérer le rendu. À traiter par une fonction d'échappement unique, appliquée sans exception.
- **Protection des actions d'écriture** : les mutations passent en `POST`, jamais par paramètres d'URL.
- **Déploiement authentifié uniquement** — pas d'accès sans connexion.
- **Retour vers NetSuite** : lien de sortie explicite, la navigation native n'étant pas présente.
- **Styles et polices** à fournir (A.3), sans dépendance à un CDN externe.
- **Accessibilité** à implémenter explicitement (A.6).

**Point d'attention** : le Suitelet doit écrire directement sa réponse HTML, et non passer par un champ `INLINEHTML` d'un formulaire. Dans ce second cas les feuilles de style de NetSuite s'appliqueraient également et entreraient en conflit avec celles de l'écran.

## B.2 Découpage des scripts

| Script | Type | Rôle |
|--------|------|------|
| `SL_Planif_Arbitrage` | Suitelet | `GET` : rend la coquille HTML. `POST` : reçoit les actions au format JSON. |
| `CS_Planif_Arbitrage` (ou JS servi depuis le File Cabinet) | Client | Interactions, calcul du total, validations d'affichage. Aucune règle métier. |
| `SL_Planif_Statut` | Suitelet | Point d'appel léger pour l'interrogation périodique de l'état du calcul (F7). Séparé pour rester peu coûteux. |
| `MR_Planif_Split` | Map/Reduce | Uniquement si le volume d'écritures d'un arbitrage devait le justifier. À priori non nécessaire : un arbitrage produit quelques lignes. |

Règle : **aucune règle métier dans le script client**. Le total, les écarts et les contrôles de date sont recalculés côté serveur avant écriture. Le client ne fait que de l'affichage anticipé.

## B.3 Contrat d'échange

Actions à prévoir sur le Suitelet, en JSON :

| Action | Entrée | Sortie |
|--------|--------|--------|
| `listItems` | — | Articles avec niveau déduit du code, nombre de propositions non firmées |
| `listOrders` | code article | Propositions de l'article, et propositions des composants directs avec date du calcul |
| `applySplit` | code article, id de la proposition d'origine, lignes (date, quantité) | Ids créés, écart constaté, entrée de journal |
| `launch` | — | Identifiant du traitement lancé |
| `status` | — | État du calcul, auteur, heure de lancement, heure de fin |

`applySplit` doit être **idempotent au regard de la proposition d'origine** : vérifier qu'elle existe encore et n'a pas déjà été remplacée avant toute écriture, afin qu'un double envoi ne produise pas deux jeux de lignes.

## B.4 Accès aux données

**Champs observés** sur un planned order généré par le moteur (relevé sur l'enregistrement 755, constat) :

`item`, `location`, `itemlocation`, `transactiontype`, `quantity`, `startdate`, `enddate`, `firmed`, `released`, `plannedorderstatus`, `planningordertype`, `planningitemlocation`, `planningengineitemlocation`, `supplyplandefinition`, `supplyplanningrun`, `tobeexpedited`, `customform`.

**Lecture** : privilégier `N/query` avec SuiteQL pour les listes — un appel unique quel que soit le volume, au lieu d'une recherche par article. Les noms de tables restent à confirmer.

**Écriture** : `record.create` avec `defaultValues` portant obligatoirement `supplyplandefinition`, `supplyplanningrun` et `firmed: 'T'` (constat, section 9). Les trois champs de liaison au moteur — `itemlocation`, `planningitemlocation`, `planningengineitemlocation` — ne sont pas devinables pour un couple article / emplacement donné : les reprendre depuis la proposition d'origine que l'on remplace, plutôt que tenter de les résoudre.

**Suppression** : `record.delete`. Un fractionnement se traduit par une suppression suivie de n créations, dans cet ordre, sous contrôle d'erreur : en cas d'échec d'une création, la proposition d'origine ne doit pas rester supprimée sans remplacement.

## B.5 Gouvernance

Les coûts en unités dépendent de la catégorie du record, et celle de `plannedorder` n'est pas établie à ce stade. **Ne pas se fier à une estimation** : instrumenter avec `runtime.getCurrentScript().getRemainingUsage()` avant et après un fractionnement réel, comme le fait le Suitelet de test, et en déduire le nombre de lignes admissible en une exécution.

Ordre de grandeur attendu : un fractionnement de 10 lignes reste très en dessous des limites d'un Suitelet. Le risque n'apparaîtrait qu'en traitement de masse, non prévu ici.

## B.6 Verrouillage (F7)

- L'état doit être déterminé d'après l'**état réel du traitement de planification**, pas d'après un indicateur propre à l'outil : un lancement effectué depuis l'écran standard doit verrouiller l'écran.
- Interrogation périodique côté client vers `SL_Planif_Statut`, intervalle de l'ordre de 5 à 10 secondes, avec arrêt automatique au-delà d'un délai maximal.
- Ne pas utiliser `N/cache` comme source de vérité : volatil. Un enregistrement personnalisé horodaté est préférable, en complément de l'état réel du traitement.
- Expiration automatique et déverrouillage manuel administrateur obligatoires.

## B.7 Lancement du calcul (F6)

Piste à tester en premier : `N/action`. Un `action.find({ recordType: 'supplyplandefinition' })` indiquera si le lancement est exposé comme action de record, donc scriptable. Hypothèse non vérifiée, à confirmer en quelques lignes.

À défaut, redirection vers l'écran standard de la Supply Plan Definition, avec retour vers l'écran d'arbitrage. Moins fluide, fonctionnellement acceptable.

## B.8 Dates et locale

Le compte est en format européen `JJ/MM/AAAA`. **Ne jamais découper une chaîne de date manuellement** — la maquette le fait, c'est un raccourci de prototype à ne pas reprendre. Utiliser `N/format` avec `format.Type.DATE` dans les deux sens, et transporter les dates en ISO dans les échanges JSON, en ne formatant qu'à l'affichage.

Les quantités décimales sont possibles (valeur observée à cinq décimales sur l'enregistrement 755). Le nombre de décimales à autoriser dépend de l'unité de mesure de l'article, à cadrer avec le client.

## B.9 Permissions

Vérifier que le rôle du planificateur dispose des droits de lecture et d'écriture sur le record `plannedorder`, ainsi que de l'accès au Supply Planning. À défaut, appliquer le schéma de Suitelet exécuté sous un rôle privilégié, déjà mis en œuvre sur ce compte pour contourner une absence de permission de lecture.

Le Suitelet ne doit pas être déployé en accès sans authentification.

## B.10 Journalisation

- Journal fonctionnel (F9) dans un enregistrement personnalisé : horodatage, utilisateur, article, proposition d'origine, lignes créées, écart de quantité.
- Journal technique via `log.audit` à chaque action reçue, avec l'identifiant de corrélation de la requête, afin qu'un incident puisse être reconstitué.
- Les écarts de quantité sont inscrits au journal fonctionnel, pas seulement technique : c'est la seule trace exploitable d'un sur-approvisionnement (F3).

## B.11 Ce que la maquette simule et qu'il ne faut pas reprendre

| Élément de la maquette | Réalité en production |
|------------------------|----------------------|
| Fonction de recalcul interne descendant les niveaux | Le moteur de planification s'en charge. L'écran ne calcule aucun éclatement. |
| Progression du verrou en trois étapes temporisées | Interrogation réelle de l'état du traitement, durée inconnue à l'avance |
| Catalogue d'articles et ratios en dur | Lecture des articles, nomenclatures et propositions en base |
| Découpage de chaînes pour les dates | `N/format` |
| État conservé en variables de page | Persistance en base ; aucun état de travail ne doit vivre uniquement côté navigateur |
| Libellés d'articles et emplacements fictifs | Données réelles |

---

# Annexe C — Organisation du projet

## C.1 Arborescence

```
planif-arbitrage/
├── docs/
│   ├── Spec_Fonctionnelle_Replanification_v0.2.md
│   └── Maquette_Fractionnement.html
├── src/
│   ├── FileCabinet/SuiteScripts/PlanifArbitrage/
│   │   ├── SL_Planif_Arbitrage.js
│   │   ├── SL_Planif_Statut.js
│   │   ├── CS_Planif_Arbitrage.js
│   │   ├── lib/planif_dao.js          ← accès données, mutualisé
│   │   └── assets/                     ← css, polices woff2
│   ├── Objects/
│   ├── manifest.xml
│   └── deploy.xml
└── README.md
```

`docs/` est hors de `src/` : le contenu n'est pas déployé dans le File Cabinet.

## C.2 Conventions

- Préfixes de scripts conformes à l'usage du compte : `SL_`, `CS_`, `UE_`, `MR_`.
- Accès aux données concentrés dans `lib/planif_dao.js` : un seul endroit à corriger lorsque les noms de tables SuiteQL ou les champs de liaison au moteur seront confirmés.
- Correspondance préfixe de code article / niveau portée par un paramètre de script, jamais en dur (section 5).

## C.3 Traçabilité

Référencer les règles et exigences dans les en-têtes de fonction :

```javascript
/**
 * Contrôle du total réparti — signalement sans blocage.
 * Spec : F3, section 10 (sur-approvisionnement non signalé par le moteur)
 */
```

Les numéros `RG1` à `RG8` et `F1` à `F9` sont stables et destinés à être cités depuis le code, les messages de commit et le cahier de recette.
