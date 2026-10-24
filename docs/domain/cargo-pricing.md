# Cargo Pricing — estimation fret versionnée

> CARGO-PRICING-1 fournit le domaine et l'API. La migration ne crée et
> n'active **aucun tarif commercial**. Tant que le propriétaire n'a pas
> publié une grille dans Pricing, l'API répond `requiresQuote=true`.

Cargo Pricing est distinct des tarifs voyageurs (`FareTable`) et des devis
manuels (`RoadFreightQuote`). Une estimation n'est ni une réservation, ni un
devis accepté, ni un paiement, ni un `RoadFreightShipment`.

## Autorité et inventaire initial

| Règle trouvée                                                           | Source                     | Méthode         | Statut automatique            |
| ----------------------------------------------------------------------- | -------------------------- | --------------- | ----------------------------- |
| Lignes de devis `CHARGE` / `DISCOUNT`                                   | CARGO-PRICE-1              | saisie OPS      | non réutilisable comme barème |
| 125,50 EUR et autres montants Cargo                                     | tests                      | synthétique     | interdit en production        |
| 249,00 EUR                                                              | Pricing voyageurs / pilote | tarif par siège | hors domaine Cargo            |
| prix/kg, prix/m³, forfait, minimum, coefficient volumétrique et options | dépôt + production audités | absent          | `OWNER_INPUT_REQUIRED`        |

La production auditée avant CARGO-PRICING-1 contenait zéro fret, zéro devis et
zéro ligne de devis. Aucun nombre historique ne constitue donc une règle.

## Modèle

`CargoPricingRule` porte une identité stable : code, libellé OPS, direction et
audience (`PUBLIC`, `PRO`, `NEGOTIATED`). Direction et audience sont
immuables.

`CargoPricingRuleVersion` porte toute la décision commerciale :

- statut `DRAFT` → `ACTIVE` → `DISABLED` ;
- version monotone, fenêtre d'effet et devise explicite ;
- méthode `ACTUAL_WEIGHT`, `VOLUMETRIC_WEIGHT`, `VOLUME`, `FLAT_RATE`,
  `TIERED_WEIGHT` ou `CUSTOM_QUOTE` ;
- taux ou forfait exact en unités mineures, minimum, arrondi explicite ;
- coefficient volumétrique seulement lorsqu'il est configuré ;
- seuils poids/volume basculant vers le devis ;
- catégories, paliers contigus et options.

Les paliers ont une borne basse inclusive et une borne haute exclusive. Ils
commencent à `0.000`, se suivent sans trou ni chevauchement et le dernier est
ouvert. Une option demandée mais absente de la version ne vaut jamais zéro :
elle déclenche un devis. `INCLUDED` est une décision explicite distincte de
l'absence de règle.

PostgreSQL impose : une seule DRAFT et une seule ACTIVE par règle, versions
actives immuables, enfants modifiables seulement en DRAFT, aucune suppression
ou troncature de l'historique. Deux règles stables actives pouvant correspondre
au même envoi restent détectées à la lecture : l'API refuse alors de choisir
arbitrairement (`AMBIGUOUS_RULE`).

## Calcul exact

Le moteur travaille avec des entiers : grammes, centimètres cubes et unités
monétaires mineures. Aucun `float` n'est l'autorité monétaire.

- poids réel : taux × grammes / 1 000 ;
- volume : taux × cm³ / 1 000 000 ;
- poids volumétrique : `ceil(cm³ × 1 000 / diviseur_cm³_par_kg)` ;
- poids facturable : maximum du poids réel et du poids volumétrique, uniquement
  pour une version qui porte le diviseur ;
- l'arrondi final (`UP`, `HALF_UP`, `DOWN`) est une donnée versionnée ;
- le minimum est restitué comme ligne d'ajustement explicable ;
- tous les montants HTTP sont des chaînes d'entiers pour préserver `BIGINT`.

Une base calculée à zéro, un dépassement de capacité monétaire ou une
configuration incohérente bascule vers `INCOMPLETE_RULE`, jamais vers `0 €`.

## API publique

`POST /v1/cargo/estimate` est anonyme, strict, limité par IP et `no-store`.
Le navigateur fournit uniquement des faits : direction PAR/DKR, poids exact,
dimensions ou volume, catégorie et options. Il ne peut fournir ni formule, ni
taux, ni devise, ni version.

La réponse contient :

- les faits normalisés ;
- `requiresQuote` et un motif stable ;
- ou le total exact, la décomposition, la méthode, la version publique
  `CODE:vN` et sa date d'effet.

Les échecs fermés sont : aucune règle, ambiguïté, cotation personnalisée,
seuil dépassé, volume manquant, palier absent, option absente/personnalisée ou
configuration incomplète.

## Administration

Les routes sont sous `/v1/admin/pricing/cargo-rules` : catalogue, détail,
création/renommage, création ou duplication de version, modification DRAFT,
prévisualisation, activation et désactivation.

- lecture et prévisualisation : `pricing.read` ;
- mutation : `pricing.manage` + CSRF ;
- audits atomiques : `CARGO_PRICING_RULE_CREATED`,
  `CARGO_PRICING_RULE_UPDATED`, `CARGO_PRICING_RULE_ACTIVATED`,
  `CARGO_PRICING_RULE_DISABLED`.

La future interface OPS consomme ces routes ; le CMS ne porte jamais les
formules ou montants.

## Données propriétaire attendues

`OWNER_INPUT_REQUIRED` avant tout montant public : barèmes par direction et
catégorie, audiences autorisées, devise/unité mineure, méthode, montants,
arrondi, minimum, coefficient volumétrique, seuils et politique de chaque
option. L'absence de ces données est un état sûr et déployable : devis requis.
