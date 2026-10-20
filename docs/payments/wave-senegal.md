# Wave Sénégal direct (PAY-SN-1A)

Vérification des sources officielles : **20 octobre 2026**.

État EURO TERANGA : **SUPPORTED = YES, IMPLEMENTED = YES, CONFIGURED = NO,
LIVE = NO**. `WAVE_SN` est routé uniquement vers `WAVE` direct, en `XOF`,
pour un payeur `SN`. PayDunya et PayTech ne sont ni routes de secours ni
intermédiaires.

## Contrat officiel vérifié

Sources primaires :

- [Wave Checkout API](https://docs.wave.com/checkout)
- [Wave webhooks](https://docs.wave.com/webhook)
- [Wave Business APIs](https://docs.wave.com/business)

Les éléments utilisés par l'adaptateur sont :

| Élément            | Contrat retenu                                                                 |
| ------------------ | ------------------------------------------------------------------------------ |
| Base API           | `https://api.wave.com`, fixe côté serveur                                      |
| Authentification   | `Authorization: Bearer <API key>`, serveur uniquement                          |
| Création           | `POST /v1/checkout/sessions`                                                   |
| Lecture            | `GET /v1/checkout/sessions/:id`                                                |
| Recherche          | `GET /v1/checkout/sessions/search?client_reference=…`                          |
| Expiration         | `POST /v1/checkout/sessions/:id/expire`                                        |
| Remboursement Wave | `POST /v1/checkout/sessions/:id/refund`                                        |
| Devise             | `XOF`, sans décimales                                                          |
| Corrélation        | `client_reference`, au plus 255 caractères                                     |
| Redirection        | `wave_launch_url`, navigateur normal, jamais iframe/webview                    |
| Statuts checkout   | `open`, `complete`, `expired`                                                  |
| Statuts paiement   | `processing`, `cancelled`, `succeeded`                                         |
| Expiration         | 30 minutes par défaut; aucune durée de création plus courte n'est documentée   |
| Succès webhook     | `checkout.session.completed`, avec `complete` et `succeeded`                   |
| Échec de tentative | `checkout.session.payment_failed`; plusieurs échecs peuvent précéder un succès |

L'API publique ne documente pas de clé d'idempotence native pour Create
Checkout. EURO TERANGA recherche donc d'abord `Payment.reference` via
`client_reference`. Après un timeout de création, il recherche encore une
fois avant toute nouvelle création. Zéro résultat permet une création; un
résultat exact est repris; plusieurs résultats ou une recherche indisponible
ferment le flux. Un état inconnu reste `PENDING` et réconciliable.

## Requête et réponse

Le serveur envoie seulement :

- `amount`: `quote.presentmentAmountMinor` converti directement de `bigint`
  en chaîne entière positive;
- `currency: XOF`;
- `client_reference: Payment.reference`;
- `success_url` et `error_url` construites depuis `CLIENT_PUBLIC_URL`.

Aucun montant, host, origin, referer ou URL du client n'est repris. La réponse
doit répéter montant, devise, référence et URLs exacts. L'id doit respecter le
format documenté `cos-…`; la redirection doit être exactement
`https://pay.wave.com/c/<même id>` (query officielle permise); la durée entre
`when_created` et `when_expires` ne peut dépasser 30 minutes plus 5 secondes
de tolérance. Une redirection ou un retour navigateur ne confirme jamais le
paiement.

## Signatures et webhook

EURO TERANGA choisit une clé API Wave créée avec la signature de requêtes
activée, bien que Wave rende cette fonction optionnelle. Chaque requête API,
y compris un GET au corps vide, porte :

```text
Wave-Signature: t=<unix>,v1=HMAC-SHA256(<timestamp><raw body>)
```

Le secret de signature API est distinct de la clé API et du secret webhook.
Wave refuse une requête signée de plus de 5 minutes dans le passé ou de plus
de 30 secondes dans le futur.

`POST /v1/payments/webhooks/wave` vérifie le `Content-Type`, un corps brut de
1 à 32 KiB, un header borné, le timestamp, puis toutes les signatures `v1`
(rotation) avec comparaison constante. Le HMAC porte sur le timestamp suivi
des **octets bruts**, jamais sur un JSON re-sérialisé. Seul l'identifiant
d'événement, le hash SHA-256 et le résultat normalisé sont persistés.

Un succès exige simultanément l'id checkout, `client_reference`, montant,
`XOF`, `checkout_status=complete` et `payment_status=succeeded` exacts. Un
événement de tentative échouée, `processing` ou `cancelled` est non terminal :
il est acquitté sans mettre l'essai en échec, car la documentation autorise
un succès ultérieur. L'id d'événement unique assure l'idempotence; même id et
même hash est un duplicata acquitté, même id avec un autre hash est un conflit.

## Hold et annulation

La session Wave reste payable 30 minutes. EURO TERANGA exige donc :

```text
WAVE_COLLECTION_WINDOW_SECONDS=1800
WAVE_HOLD_MARGIN_SECONDS=300
minimumHoldRemainingSeconds=2100
```

Le hold par défaut actuel (`BOOKING_HOLD_TTL_SECONDS=900`) est incompatible :
l'adaptateur est implémenté mais la méthode reste indisponible. Une activation
future nécessite une décision produit explicite relevant le hold, par exemple
à 3600 secondes. PAY-SN-1A ne change pas ce TTL.

Avant une annulation locale, EURO TERANGA appelle l'expiration Wave. Succès ou
checkout déjà `expired` donne `CLOSED`; `complete` + `succeeded` donne
`COMPLETED` et l'annulation locale est refusée; timeout ou état inconnu garde
l'essai `PENDING` pour réconciliation.

## Configuration et onboarding

Wave ne documente pas de sandbox. Les seuls modes sont `DISABLED | LIVE` :

- `PAYMENT_WAVE_MODE=DISABLED` par défaut, sans aucun credential;
- `PAYMENT_WAVE_API_KEY`;
- `PAYMENT_WAVE_WEBHOOK_SECRET` (`wave_sn_WHS_…` officiel);
- `PAYMENT_WAVE_REQUEST_SIGNING_SECRET` (`wave_sn_AKS_…` officiel).

`WAVE_LIVE_MODE_ENABLED=false` ferme LIVE dans cette release. Le pilot refuse
LIVE et toute credential. Avant une future activation : contrat marchand,
webhook enregistré, secret dédié, horloge synchronisée, IP de sortie statique
ajoutée à l'allowlist API Wave, plages webhook Wave courantes filtrées à
l'edge d'après la documentation officielle, runbook de rotation et essai de
réconciliation. Les listes d'IP ne sont pas figées dans le code.

Wave documente le remboursement de checkout, mais l'interface générique
EURO TERANGA ne l'exécute pas encore :

```text
WAVE_PROVIDER_REFUND_CAPABILITY=SUPPORTED
EURO_TERANGA_REFUND_EXECUTION=NOT_YET_IMPLEMENTED
```
