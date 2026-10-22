# CARGO-1 — Colis & fret routier

CARGO-1 crée un domaine de fret indépendant de `Baggage`. Un colis commercial
n'est jamais transformé en bagage passager.

## Périmètre

Inclus :

- Paris → Dakar et Dakar → Paris ;
- référence publique opaque `ETC-…` ;
- expéditeur, destinataire et contacts privés OPS ;
- poids exact, volume en litres, nombre de pièces et dimensions facultatives ;
- contenu et valeur déclarés ;
- réservation client facultative ;
- affectation explicite à un voyage et à un véhicule du convoi ;
- capacité kg + litres verrouillée en base ;
- historique append-only et idempotence des événements ;
- RBAC `cargo.read` / `cargo.manage` et audit des lectures/écritures ;
- workspace OPS « Colis & fret ».

Hors périmètre :

- prix, devis monétaire, promotions et paiement (`CARGO-PRICE-1`) ;
- QR/scans et tracking public (`CARGO-TRACK-1`) ;
- documents douaniers privés ;
- déclenchement automatique du véhicule support ;
- calcul de marge/rentabilité ;
- création client autonome.

L'état `QUOTE` représente une demande opérationnelle sans montant. Aucun prix
n'est stocké dans CARGO-1.

## Modèle

`RoadFreightShipment` porte les faits courants. `RoadFreightShipmentEvent`
est l'historique immuable.

Cycle normal :

```
QUOTE → BOOKED → RECEIVED → INSPECTED → ASSIGNED → LOADED
→ DEPARTED → IN_TRANSIT → ARRIVED → AVAILABLE → DELIVERED
```

Terminaux :

- `REFUSED` : possible tant que le fret n'est pas déjà terminal ;
- `CANCELLED` : uniquement avant chargement.

Exceptions séparées :

- `HELD`
- `CUSTOMS_HOLD`
- `DAMAGED`

Une exception bloque la progression jusqu'à `EXCEPTION_RESOLVED`.

## Affectation et capacité

L'affectation n'est possible qu'après `INSPECTED`.

Le véhicule ciblé doit :

- appartenir au voyage comme véhicule principal ou support ;
- être `ACTIVE` ;
- avoir `payloadCapacityKg` et `cargoVolumeLiters` configurés.

La direction du voyage doit correspondre au sens du fret. Si un
`bookingReference` est lié au fret, l'affectation doit utiliser le même voyage.

La base prend un advisory lock sur le couple voyage/véhicule puis additionne
les autres frets actifs. Une affectation ou une correction de poids/volume qui
dépasserait la charge utile ou le volume est refusée.

Une modification ultérieure du véhicule principal ou du véhicule support du
voyage est également refusée si elle laisserait un fret actif affecté à un
véhicule qui sort du convoi. OPS doit d'abord réaffecter ou terminer ce fret.

CARGO-1 compte uniquement le fret commercial. L'intégration de la franchise et
des bagages supplémentaires dans le même budget de capacité appartient à
`BAGGAGE-PLUS-1`.

## Données et audit

Les contacts et le contenu déclaré sont des données privées OPS. Ils ne sont
jamais exposés sur une route publique.

Les actions d'audit évitent de recopier les contacts ou le contenu déclaré :

- `ROAD_FREIGHT_CREATED`
- `ROAD_FREIGHT_UPDATED`
- `ROAD_FREIGHT_ASSIGNED`
- `ROAD_FREIGHT_ASSIGNMENT_CHANGED`
- `ROAD_FREIGHT_EVENT_RECORDED`
- `ROAD_FREIGHT_ACCESSED`

Les caractéristiques commerciales deviennent immuables à partir de
`LOADED`. Le fret et ses événements ne sont jamais supprimés physiquement.

## API STAFF

Toutes les routes sont sous `/v1/admin/cargo`.

| Méthode | Route | Permission |
| --- | --- | --- |
| GET | `/` | cargo.read |
| GET | `/:reference` | cargo.read |
| POST | `/` | cargo.manage |
| POST | `/:reference/details` | cargo.manage |
| POST | `/:reference/assignment` | cargo.manage |
| POST | `/:reference/events` | cargo.manage |

Toutes les mutations exigent CSRF.
