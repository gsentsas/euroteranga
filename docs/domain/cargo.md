# CARGO — Colis, fret routier et devis commerciaux

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
- association facultative à une identité `CUSTOMER` existante, avec ou sans réservation ;
- affectation explicite à un voyage et à un véhicule du convoi ;
- capacité kg + litres verrouillée en base ;
- historique append-only et idempotence des événements ;
- RBAC `cargo.read` / `cargo.manage` et audit des lectures/écritures ;
- workspace OPS « Colis & fret ».

CARGO-PRICE-1 ajoute ensuite les devis commerciaux versionnés, sans formule de
prix automatique : les lignes sont saisies explicitement par OPS et le total
est dérivé côté serveur en unités monétaires mineures exactes.

Hors périmètre :

- paiement Cargo, FX, promotions et calculateur public ;
- QR/scans et tracking public (`CARGO-TRACK-1`) ;
- documents douaniers privés ;
- déclenchement automatique du véhicule support ;
- calcul de marge/rentabilité ;
- création client autonome.

L'état `QUOTE` reste un statut opérationnel du fret. Le prix n'est pas porté
par `RoadFreightShipment` : CARGO-PRICE-1 le stocke dans des objets
`RoadFreightQuote` séparés et historisés.

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

Tant qu'un fret actif reste affecté au véhicule, Fleet interdit également de
rendre ce véhicule non actif, de supprimer ses capacités kg/L ou de réduire
l'une des capacités sous la charge commerciale déjà affectée. Ce garde-fou est
appliqué en PostgreSQL, y compris pour une écriture SQL directe.

CARGO-1 compte uniquement le fret commercial. L'intégration de la franchise et
des bagages supplémentaires dans le même budget de capacité appartient à
`BAGGAGE-PLUS-1`.

## Client, données et audit

Le fret peut être créé sans compte client, lié directement à une identité
`CUSTOMER` existante, ou lié à une réservation. Avec une réservation, le
client est dérivé du `Booking`; si un identifiant client est également fourni,
les deux doivent correspondre. CARGO-1 ne crée jamais de client.

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

## Devis commerciaux — CARGO-PRICE-1

Chaque `RoadFreightShipment` peut posséder plusieurs versions de
`RoadFreightQuote`, identifiées par une référence opaque `ETCQ-…`.

Une version capture explicitement les faits ayant servi au chiffrage :

- direction ;
- poids exact ;
- volume ;
- nombre de pièces ;
- fragile / professionnel ;
- collecte / livraison ;
- `shipmentUpdatedAt`.

Ce snapshot ne contient ni contact expéditeur/destinataire ni contenu déclaré.

Les lignes `RoadFreightQuoteLine` sont de type `CHARGE` ou `DISCOUNT`.
Le montant est stocké en `BIGINT` dans l'unité mineure de la devise. Aucun
`float` ni `number` JavaScript n'est utilisé pour calculer le total :

```
totalMinor = Σ CHARGE - Σ DISCOUNT
```

Le total ne peut jamais devenir négatif.

Cycle d'un devis :

```
DRAFT → ISSUED → ACCEPTED
           ├──→ SUPERSEDED
           └──→ CANCELLED

DRAFT ─────────→ CANCELLED
```

Règles structurantes :

- une seule version `DRAFT` par fret ;
- une seule version `ISSUED` courante ;
- version allouée sous verrou du fret, sans trou concurrent ;
- émission d'une nouvelle version : ancien `ISSUED` → `SUPERSEDED`
  atomiquement ;
- un devis `ACCEPTED` bloque toute nouvelle émission ;
- lignes modifiables uniquement en `DRAFT` ;
- `ISSUED`, `ACCEPTED`, `SUPERSEDED` et `CANCELLED` conservent
  l'historique ;
- aucune suppression ni `TRUNCATE` ;
- aucune création de `Payment`, `PaymentQuote` ou `TripRevenue`.

Le RBAC sépare exploitation et décision de prix :

- lecture : `cargo.read + pricing.read` ;
- mutation / émission / acceptation / annulation :
  `cargo.manage + pricing.manage` + CSRF.

Ainsi, les rôles opérationnels qui gèrent le fret sans `pricing.manage` ne
peuvent pas fixer seuls un prix.

Audit dédié :

- `ROAD_FREIGHT_QUOTE_CREATED`
- `ROAD_FREIGHT_QUOTE_LINES_REPLACED`
- `ROAD_FREIGHT_QUOTE_ISSUED`
- `ROAD_FREIGHT_QUOTE_SUPERSEDED`
- `ROAD_FREIGHT_QUOTE_ACCEPTED`
- `ROAD_FREIGHT_QUOTE_CANCELLED`
- `ROAD_FREIGHT_QUOTE_ACCESSED`

## QR, scanner et suivi public — CARGO-TRACK-1

Le QR opérationnel Cargo utilise le payload versionné :

```
ETC1:<ETC-reference>
```

Il contient uniquement la référence opaque du fret. Il ne contient ni nom,
contact, contenu déclaré, valeur, booking, customer, prix ni URL publique.
L'SVG est rendu localement ; un QR reste un identifiant et jamais une
autorisation.

Le scanner STAFF réutilise le même moteur `recordEvent` que les mutations
Cargo normales : mêmes transitions, même verrouillage PostgreSQL, même
idempotence et même audit.

Le partage public utilise `RoadFreightPublicToken`. Le token brut est un
secret CSPRNG 256 bits retourné une seule fois à la création ; seule son
empreinte SHA-256 est persistée. Un token peut expirer ou être révoqué de
manière irréversible. Les tokens et leur historique ne peuvent être ni
supprimés ni tronqués.

La route publique est :

`GET /v1/cargo-tracking/:token`

Elle renvoie uniquement une projection coarse-grained :

- référence Cargo opaque ;
- direction Paris ↔ Dakar ;
- statut public borné ;
- nombre de pièces ;
- route et horaires planifiés si un voyage est affecté ;
- dernier waypoint public connu et son horodatage.

Elle n'expose jamais les coordonnées expéditeur/destinataire, le customer, la
réservation, le contenu/valeur déclarés, les devis/prix, les UUIDs internes,
les acteurs d'audit ou une position GPS précise.

Les statuts internes et exceptions sont projetés vers :

`PREPARING | RECEIVED | IN_TRANSIT | ARRIVED | AVAILABLE | DELIVERED | ATTENTION | CANCELLED`

Les catégories d'exception sensibles sont volontairement réduites à
`ATTENTION`.

## API STAFF

Toutes les routes sont sous `/v1/admin/cargo`.

| Méthode | Route                                         | Permission                    |
| ------- | --------------------------------------------- | ----------------------------- |
| GET     | `/`                                           | cargo.read                    |
| GET     | `/:reference`                                 | cargo.read                    |
| POST    | `/`                                           | cargo.manage                  |
| POST    | `/:reference/details`                         | cargo.manage                  |
| POST    | `/:reference/assignment`                      | cargo.manage                  |
| POST    | `/:reference/events`                          | cargo.manage                  |
| GET     | `/:reference/quotes`                          | cargo.read + pricing.read     |
| GET     | `/:reference/quotes/:quoteReference`          | cargo.read + pricing.read     |
| POST    | `/:reference/quotes`                          | cargo.manage + pricing.manage |
| POST    | `/:reference/quotes/:quoteReference`          | cargo.manage + pricing.manage |
| POST    | `/:reference/quotes/:quoteReference/issue`    | cargo.manage + pricing.manage |
| POST    | `/:reference/quotes/:quoteReference/accept`   | cargo.manage + pricing.manage |
| POST    | `/:reference/quotes/:quoteReference/cancel`   | cargo.manage + pricing.manage |
| GET     | `/:reference/qr`                              | cargo.read                    |
| POST    | `/resolve-qr`                                 | cargo.read                    |
| POST    | `/scan`                                       | cargo.manage                  |
| GET     | `/:reference/tracking-tokens`                 | cargo.read                    |
| POST    | `/:reference/tracking-tokens`                 | cargo.manage                  |
| POST    | `/:reference/tracking-tokens/:tokenId/revoke` | cargo.manage                  |

Toutes les mutations exigent CSRF.
