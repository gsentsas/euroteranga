# EURO TERANGA OPS — design contract

Issue maître : #142
Référence de départ : `main` à `d37f4b9baa84d861ef3807fff7d1c8743c85b30e`

## Produit et usage

EURO TERANGA OPS est le poste de contrôle quotidien des équipes qui supervisent le réseau,
les voyages, la flotte, les voyageurs, le fret et la conformité. Le shell doit rester dense,
calme et immédiatement scannable pendant des sessions de travail longues.

- Utilisateurs : exploitation, réservation, finance, conformité et administration.
- Action principale : repérer une situation, ouvrir sa fiche et agir selon les permissions.
- Hiérarchie : navigation globale, contexte de page, indicateurs, filtres, données, détail.
- Ton : industriel raffiné, fiable, précis, sans effets décoratifs gratuits.
- Détail mémorable : un rail bleu nuit continu, rythmé par un accent or réservé à
  l'orientation et aux actions primaires.

## Observations de la maquette

| Observation                                            | Décision vérifiable                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Topbar et sidebar forment un centre de contrôle sombre | Les deux surfaces utilisent les tokens navy 950/900 et restent fixes sur grand écran.               |
| Le contenu métier repose sur des surfaces claires      | Le canvas est gris bleuté et les cartes sont blanches avec une bordure fine.                        |
| Le jaune attire vers les actions                       | Le token gold est utilisé pour l'élément actif et les actions primaires, jamais comme état positif. |
| La navigation est dense mais structurée                | Six groupes nommés, icônes cohérentes, cible minimale de 44 px et RBAC inchangé.                    |
| Les informations secondaires restent discrètes         | Une échelle typographique compacte et une couleur muted dédiée sont utilisées.                      |

## Tokens

La source lisible par machine est `design-tokens.json`. Les variables runtime sont préfixées
`--ops-*` dans `apps/ops/app/ops.css` afin de ne pas modifier le thème des autres applications.

- Palette : bleu nuit, surfaces neutres, accent or, états sémantiques séparés.
- Typographie : pile système pour éviter toute ressource distante et tout coût de bundle.
- Espacement : grille de 4 px, avec 8/12/16/24 px comme rythme principal.
- Rayons : 8 px pour les contrôles, 12 px pour les cartes, 16 px pour les panneaux majeurs.
- Ombres : faibles et froides ; aucune ombre ne remplace une bordure ou un état de focus.

## Contrat responsive

- `1440x900` et `1680x941` : sidebar fixe, topbar fixe, contenu large et dense.
- `768x1024` : sidebar hors-canvas, topbar compacte, tableaux horizontalement contenus.
- `390x844` : menu drawer, recherche sur une seconde ligne, cartes en une colonne.
- Aucun contrôle ne doit provoquer un débordement horizontal du document.
- Les cibles interactives ont une taille minimale de 44 px dans le shell.

## Contrat accessibilité

- Un seul `h1`, landmarks explicites et lien d'évitement en premier élément focusable.
- Focus visible à contraste élevé sur toute surface claire ou sombre.
- Navigation et recherche utilisables au clavier ; `Escape` ferme les surfaces temporaires.
- Le menu mobile contient le focus tant qu'il est ouvert et restitue le focus à son déclencheur.
- Les icônes décoratives sont cachées de l'arbre d'accessibilité ; les boutons icônes ont un nom.
- Les états ne reposent jamais uniquement sur une couleur.

## États de contenu

| État       | Retour visible                                           | Action sûre                                  |
| ---------- | -------------------------------------------------------- | -------------------------------------------- |
| Chargement | Structure stable et libellé `role=status`                | Attendre ; aucune mutation automatique       |
| Vide       | Explication contextualisée                               | Action de création seulement si autorisée    |
| Erreur     | Message précis et `role=alert`                           | Réessayer lorsque la requête est idempotente |
| Partiel    | Données disponibles conservées, indisponibilité annoncée | Consulter ou recharger la partie concernée   |
| Succès     | Confirmation textuelle                                   | Continuer ou annuler si le métier le permet  |
| Permission | Limite d'accès explicite                                 | Retour ou déconnexion, jamais contournement  |

## Garde-fous

- Aucun changement des API, du schéma Prisma ou des règles métier dans les lots UI.
- Aucun nombre métier fictif ; tout KPI provient du backend ou est absent.
- Aucun ajout de bibliothèque UI ou d'icônes lourde.
- Le filtrage de navigation reste une commodité ; le Core API reste l'autorité RBAC.
- Les versions publiées restent immuables.

## Revue visuelle

Chaque lot conserve des captures locales aux trois viewports du contrat et un rapport de preuve
compatible avec le vérificateur ECC. Une capture sans baseline est signalée comme preuve de rendu,
pas comme test de non-régression pixel à pixel.
