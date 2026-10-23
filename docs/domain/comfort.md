# TERANGA-COMFORT-1 — confort voyageur, pauses et prochaines étapes

## Objectif

TERANGA-COMFORT-1 donne au voyageur une lecture simple de la progression de son trajet :
dernière étape connue, prochaine étape, prochaine pause et services associés.

Le modèle ne crée pas un second réseau de pauses. Les étapes et services planifiés proviennent des
waypoints de la route et des métadonnées TERANGA-STOPS.

## Source de vérité

- les arrêts et checkpoints viennent de la version de route du voyage ;
- `Checkpoint.terangaKind` décrit le type de pause ou d'étape ;
- `Checkpoint.travellerVisible` décide si un checkpoint peut être projeté au voyageur ;
- `Checkpoint.suggestedDwellMinutes` reste une durée indicative ;
- `Checkpoint.facilities` contient les services planifiés ;
- les services réellement fournis ne sont renseignés que sur un événement `COMPLETED`.

Aucun service planifié n'est présenté comme garanti.

## États

La projection dérive `PLANNED` lorsqu'aucun événement n'existe. Les événements explicites sont :

- `CONFIRMED` ;
- `COMPLETED` ;
- `CANCELLED` ;
- `SKIPPED`.

Les événements sont append-only. Un état terminal ne doit pas être réécrit : l'historique reste
conservé pour l'audit.

## Projections

### Client authentifié

`GET /v1/booking/bookings/:reference/comfort`

La réservation doit être confirmée, non annulée et appartenir à l'identité CUSTOMER connectée.
Une réservation d'un autre client est indistinguable d'une réservation inconnue.

La projection ne contient ni ID de waypoint, ni ID d'identité, ni note OPS.

### Tracking public

`GET /v1/tracking/:token`

Le confort est ajouté à la capability Tracking existante. Les mêmes règles de visibilité publique
s'appliquent : aucun checkpoint `travellerVisible=false` n'est projeté et aucun GPS supplémentaire
n'est ajouté par TERANGA-COMFORT.

Le Tracking public ne contient pas les IDs internes des événements ou waypoints.

### OPS

`GET /v1/admin/tracking/trips/:tripId/comfort`

Nécessite `tracking.read`.

`POST /v1/admin/tracking/trips/:tripId/comfort/events`

Nécessite `tracking.manage`, une session STAFF valide et un jeton CSRF. Chaque création est
auditée par `COMFORT_WAYPOINT_EVENT_RECORDED`.

Les écritures utilisent un `clientEventId` idempotent. Réutiliser le même identifiant avec un
payload différent provoque `COMFORT_CLIENT_EVENT_ID_REUSED`.

## Interfaces

- Client : une réservation confirmée peut charger son suivi de confort à la demande ;
- Tracking public : dernière étape connue, prochaine étape, prochaine pause et services visibles ;
- OPS Tracking : vue complète des waypoints, états, visibilité, services prévus/réels et historique.

Les interfaces utilisent explicitement les termes « prévu », « indicatif » et « confirmé » afin de
ne pas transformer une planification opérationnelle en promesse commerciale.

## Données sensibles

Les projections voyageur ne doivent jamais exposer :

- `routeWaypointId` ;
- `tripId` interne ;
- `recordedByIdentityId` ;
- notes ou données internes OPS ;
- identité du conducteur ou de l'équipage ;
- position GPS plus précise que le niveau Tracking déjà autorisé.

Les IDs internes restent disponibles uniquement dans la projection OPS nécessaire aux mutations.
