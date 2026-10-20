# Orange Money Sénégal direct — blocage documenté (PAY-SN-1B)

Vérification des sources officielles : **20 octobre 2026**.

État EURO TERANGA : **SUPPORTED = YES, IMPLEMENTED = NO, CONFIGURED = NO,
LIVE = NO**.

```text
ORANGE_MONEY_ADAPTER=BLOCKED_PENDING_OFFICIAL_MERCHANT_DOCS
```

La cible produit reste `ORANGE_MONEY_SN -> ORANGE_MONEY` direct, payeur `SN`,
devise `XOF`. Il n'existe aucun fallback vers Wave, carte, PayDunya ou PayTech.

## Ce que les sources officielles prouvent

Sources primaires consultées :

- [Orange Money Web Payment / M Payment](https://developer.orange.com/apis/om-webpay)
- [FAQ officielle Orange Money Web Payment](https://developer.orange.com/apis/om-webpay/faq)
- [Demande d'accès Orange Money](https://developer.orange.com/products/payment/apply-orange-money/)

Les pages publiques confirment que Web Payment / M Payment est disponible au
Sénégal, réservé aux marchands Orange Money approuvés, et que les détails
d'intégration sont transmis pendant la souscription/onboarding local. Elles
décrivent un parcours où le client génère via USSD un mot de passe temporaire
(OTP) et le saisit sur l'écran de paiement.

## Contrat public insuffisant

Les sources publiques actuelles ne permettent pas de confirmer de façon
fiable pour le produit marchand Sénégal :

- l'endpoint exact de création et son environnement;
- le schéma request/response, la devise et les contraintes montant;
- l'authentification exacte de cette API (un OAuth Orange générique ne suffit
  pas à le prouver);
- les identifiants marchand requis;
- l'exigence MSISDN et son format exact;
- le champ, la longueur et le format OTP, ni si EURO TERANGA doit le voir;
- les statuts terminaux et non terminaux;
- l'endpoint de statut/réconciliation;
- le mécanisme signé de callback/webhook, s'il existe;
- l'idempotence/order reference;
- le contrat de remboursement;
- un environnement de test Sénégal et son onboarding.

Appliquer un ancien exemple d'un autre pays ou un blog serait inventer un
contrat de paiement. Aucun client HTTP, endpoint, statut, OAuth, credential,
merchant id, callback secret ou champ OTP n'est donc créé dans PAY-SN-1A.
`PAYMENT_ORANGE_MONEY_MODE` accepte uniquement `DISABLED`; le pilot refuse
toute variable non vide dans l'espace `PAYMENT_ORANGE_MONEY_*` en dehors du
mode. Aucun adaptateur Orange n'est injecté et la méthode est indisponible.

## Conditions de déblocage

Le détenteur du compte marchand doit fournir les documents officiels Sénégal
reçus pendant l'onboarding, avec version/date et autorisation d'utilisation.
PAY-SN-1B pourra commencer seulement après validation de chaque point manquant
ci-dessus et des tests de statut côté serveur.

Si le contrat impose que l'OTP passe par EURO TERANGA, il sera éphémère en
mémoire durant un POST HTTPS authentifié et rate-limité : aucune colonne,
persistance, cache, URL, audit, log, trace, analytics, erreur ou réponse ne le
contiendra. Aucun PIN, code secret Orange Money ou mot de passe permanent ne
sera demandé. Un parcours Orange hébergé qui évite la collecte de l'OTP sera
préféré.
