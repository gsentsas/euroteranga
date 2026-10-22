# OPS-PROFIT-1 — Rentabilité opérationnelle par voyage

OPS-PROFIT-1 ajoute une projection analytique **en lecture seule** pour comparer
les résultats Finance, le budget opérationnel et l'activité Cargo d'un voyage.

Ce domaine n'est pas un grand livre comptable et n'ajoute aucune table.

## Sources de vérité

### Réalisé Finance

La projection réutilise exactement la même fonction de calcul que le domaine
Finance :

```text
gross revenue = succeeded ticket payments + active additional revenues
net revenue   = gross revenue - refunds
contribution  = net revenue - active expenses
outstanding   = active expenses - payouts
```

Les écritures `VOIDED` sont exclues. Les payouts ne sont jamais soustraits
une seconde fois de la contribution.

Chaque devise reste dans son propre bucket
`(currencyCode, currencyMinorUnit)`. Aucun FX n'est appliqué.

### Prévisionnel TripCost

Le budget vient exclusivement de `TripCostPlan`.

- absence de plan : `plannedCost = null` ;
- `DRAFT` : budget en préparation ;
- `ESTIMATED` : estimation ;
- `LOCKED` : référence verrouillée.

Pour EUR :

```text
variance = actual expenses - planned cost
remaining budget = planned cost - actual expenses
```

Une variance positive signifie un dépassement. Le pourcentage est exposé en
basis points signés afin de ne pas convertir les montants en nombres flottants.

### Commercial Cargo

Les devis `RoadFreightQuote(status=ACCEPTED)` affectés au voyage sont
agrégés par devise comme **valeur commerciale acceptée**.

Ils ne sont jamais ajoutés à :

- ticket revenue ;
- additional revenue ;
- gross revenue ;
- net revenue ;
- contribution.

`recognizedRevenueMinor` reste explicitement `0` dans OPS-PROFIT-1.
La reconnaissance d'un revenu Cargo nécessitera un workflow Finance distinct.

## Capacité Cargo

L'occupation Cargo utilise uniquement les frets dans les états qui consomment
encore une capacité opérationnelle :

- `ASSIGNED`
- `LOADED`
- `DEPARTED`
- `IN_TRANSIT`
- `ARRIVED`
- `AVAILABLE`

Le poids reste exact à trois décimales. Aucun `Number` ou `parseFloat`
n'est utilisé pour l'additionner.

La capacité du convoi additionne uniquement les véhicules primaire/support
pour lesquels les deux capacités Cargo sont déclarées.

## API et RBAC

Route :

`GET /v1/admin/ops-profit/trips/:tripReference`

Permissions requises :

- `finance.read`
- `trip.read`

La route est STAFF uniquement, auditée et `Cache-Control: no-store`.

## Privacy

La projection Cargo est agrégée. Elle ne contient pas :

- noms ou contacts expéditeur/destinataire ;
- contenu déclaré ;
- valeur déclarée privée ;
- customer identity ;
- booking customer ;
- token de suivi ;
- position GPS.

## OPS

L'écran Finance affiche quatre blocs read-only :

1. **Réalisé Finance**
2. **Prévisionnel**
3. **Commercial Cargo non reconnu**
4. **Occupation Cargo du convoi**

Les libellés évitent de présenter la valeur commerciale Cargo comme du chiffre
d'affaires ou de la contribution.

## Deliberate exclusions

- comptabilité générale / FEC ;
- fiscalité / TVA ;
- conversion FX ;
- forecast automatique ;
- IA de marge ;
- auto-pricing ;
- décision automatique de départ ;
- paiement Cargo ;
- création automatique de `TripRevenue` depuis un devis Cargo ;
- déploiement production.
