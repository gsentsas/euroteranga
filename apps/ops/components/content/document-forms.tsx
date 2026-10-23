'use client';

import { type SOCIAL_NETWORKS, type ContentKind } from '@euroteranga/content';
import { BlocksField } from './block-forms';
import { useEditor } from './editor-context';
import {
  CheckboxField,
  LinkFields,
  ListField,
  MediaField,
  OwnerTextField,
  SelectField,
  TextField,
} from './fields';

const SOCIAL_LABELS: Record<(typeof SOCIAL_NETWORKS)[number], string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
};

function PageForm() {
  const editor = useEditor();
  const seoLocked = !editor.canManageSeo;
  return (
    <>
      <section className="ops-content-section" aria-labelledby="content-page-general">
        <h3 id="content-page-general">Page</h3>
        <TextField
          path={['title']}
          label="Titre de la page"
          max={140}
          required
          hint="Titre principal (H1) quand la page n’a pas de bandeau d’accueil."
        />
      </section>
      <section className="ops-content-section" aria-labelledby="content-page-seo">
        <h3 id="content-page-seo">Référencement</h3>
        {seoLocked ? (
          <p className="et-hint">
            Ces champs demandent la permission seo.manage : ils restent tels qu’ils sont publiés.
          </p>
        ) : null}
        <TextField
          path={['seo', 'title']}
          label="Titre dans les résultats de recherche"
          max={70}
          disabled={seoLocked}
          hint="Par défaut, le titre de la page."
        />
        <TextField
          path={['seo', 'description']}
          label="Description dans les résultats de recherche"
          max={170}
          required
          multiline
          rows={2}
          disabled={seoLocked}
        />
        <CheckboxField
          path={['seo', 'indexable']}
          label="Page indexable et listée dans le plan du site"
          disabled={seoLocked}
          hint="Le site entier reste non indexé tant que la production n’ouvre pas l’indexation."
        />
        <MediaField path={['seo', 'socialMediaId']} label="Image de partage" disabled={seoLocked} />
      </section>
      <BlocksField path={['blocks']} />
    </>
  );
}

function SettingsForm() {
  return (
    <>
      <section className="ops-content-section" aria-labelledby="content-settings-brand">
        <h3 id="content-settings-brand">Marque</h3>
        <TextField path={['brandName']} label="Nom affiché" max={60} required />
        <TextField path={['slogan']} label="Slogan" max={160} />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-contact">
        <h3 id="content-settings-contact">Contact</h3>
        <p className="et-hint">
          Un champ vide reste « à compléter » : il n’est pas affiché sur le site, jamais remplacé
          par une valeur inventée.
        </p>
        <OwnerTextField path={['contact', 'email']} label="Adresse e-mail" max={200} type="email" />
        <OwnerTextField path={['contact', 'phone']} label="Téléphone" max={40} type="tel" />
        <OwnerTextField path={['contact', 'address']} label="Adresse" max={300} multiline />
        <OwnerTextField path={['contact', 'hours']} label="Horaires du service client" max={200} />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-legal">
        <h3 id="content-settings-legal">Mentions légales</h3>
        <OwnerTextField path={['legal', 'companyName']} label="Raison sociale" max={160} />
        <OwnerTextField path={['legal', 'legalForm']} label="Forme juridique" max={80} />
        <OwnerTextField
          path={['legal', 'registeredAddress']}
          label="Siège social"
          max={300}
          multiline
        />
        <OwnerTextField path={['legal', 'shareCapital']} label="Capital social" max={60} />
        <OwnerTextField
          path={['legal', 'registrationNumber']}
          label="Immatriculation (RCS, NINEA…)"
          max={80}
        />
        <OwnerTextField path={['legal', 'vatNumber']} label="Numéro de TVA" max={40} />
        <OwnerTextField
          path={['legal', 'publicationDirector']}
          label="Directeur de la publication"
          max={120}
        />
        <OwnerTextField path={['legal', 'hostName']} label="Hébergeur" max={160} />
        <OwnerTextField path={['legal', 'hostAddress']} label="Adresse de l’hébergeur" max={300} />
        <OwnerTextField path={['legal', 'hostContact']} label="Contact de l’hébergeur" max={120} />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-privacy">
        <h3 id="content-settings-privacy">Confidentialité</h3>
        <p className="et-hint">
          Ces valeurs sont des engagements du responsable du traitement. Laissez un champ vide
          tant que sa valeur n’a pas été explicitement validée : elle ne sera jamais inventée.
        </p>
        <OwnerTextField
          path={['privacy', 'dataController']}
          label="Responsable du traitement"
          max={200}
          multiline
        />
        <OwnerTextField
          path={['privacy', 'privacyContact']}
          label="DPO ou contact confidentialité"
          max={200}
          multiline
        />
        <OwnerTextField
          path={['privacy', 'purposesAndLegalBases']}
          label="Finalités et bases légales"
          max={1200}
          multiline
        />
        <OwnerTextField
          path={['privacy', 'retentionPeriods']}
          label="Durées de conservation"
          max={1200}
          multiline
        />
        <OwnerTextField
          path={['privacy', 'processors']}
          label="Sous-traitants"
          max={1200}
          multiline
        />
        <OwnerTextField
          path={['privacy', 'transfersOutsideEu']}
          label="Transferts hors Union européenne"
          max={1200}
          multiline
        />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-social">
        <h3 id="content-settings-social">Réseaux sociaux</h3>
        <ListField
          path={['social']}
          legend="Comptes"
          itemLabel={(index) => `Compte ${index + 1}`}
          max={8}
          addLabel="Ajouter un compte"
          create={() => ({ network: 'facebook', url: '' })}
          render={(itemPath) => (
            <div className="ops-content-grid">
              <SelectField
                path={[...itemPath, 'network']}
                label="Réseau"
                options={Object.entries(SOCIAL_LABELS)}
              />
              <TextField path={[...itemPath, 'url']} label="Adresse https" max={500} required />
            </div>
          )}
        />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-apps">
        <h3 id="content-settings-apps">Applications</h3>
        <TextField path={['apps', 'bookingUrl']} label="Réservation" max={200} required />
        <TextField path={['apps', 'clientUrl']} label="Espace client" max={200} required />
        <TextField path={['apps', 'trackingUrl']} label="Suivi du trajet" max={200} required />
      </section>
      <section className="ops-content-section" aria-labelledby="content-settings-footer">
        <h3 id="content-settings-footer">Pied de page</h3>
        <TextField path={['footer', 'intro']} label="Présentation" max={300} required multiline />
        <TextField path={['footer', 'notice']} label="Mention" max={300} multiline />
      </section>
    </>
  );
}

function NavigationForm() {
  return (
    <>
      <section className="ops-content-section" aria-labelledby="content-navigation-header">
        <h3 id="content-navigation-header">En-tête</h3>
        <ListField
          path={['header']}
          legend="Liens du menu"
          itemLabel={(index) => `Lien ${index + 1}`}
          max={7}
          addLabel="Ajouter un lien"
          create={() => ({ label: '', target: { kind: 'page', path: '/' } })}
          render={(itemPath, index) => <LinkFields path={itemPath} legend={`Lien ${index + 1}`} />}
        />
        <LinkFields path={['headerCta']} legend="Bouton de l’en-tête" optional />
      </section>
      <section className="ops-content-section" aria-labelledby="content-navigation-footer">
        <h3 id="content-navigation-footer">Pied de page</h3>
        <ListField
          path={['footer']}
          legend="Colonnes"
          itemLabel={(index) => `Colonne ${index + 1}`}
          max={4}
          addLabel="Ajouter une colonne"
          create={() => ({
            title: '',
            links: [{ label: '', target: { kind: 'page', path: '/' } }],
          })}
          render={(itemPath, column) => (
            <>
              <TextField
                path={[...itemPath, 'title']}
                label="Titre de la colonne"
                max={40}
                required
              />
              <ListField
                path={[...itemPath, 'links']}
                legend="Liens"
                itemLabel={(index) => `Colonne ${column + 1}, lien ${index + 1}`}
                min={1}
                max={8}
                addLabel="Ajouter un lien"
                create={() => ({ label: '', target: { kind: 'page', path: '/' } })}
                render={(linkPath, index) => (
                  <LinkFields path={linkPath} legend={`Lien ${index + 1}`} />
                )}
              />
            </>
          )}
        />
      </section>
    </>
  );
}

export function DocumentForm({ kind }: { kind: ContentKind }) {
  if (kind === 'PAGE') return <PageForm />;
  if (kind === 'SITE_SETTINGS') return <SettingsForm />;
  return <NavigationForm />;
}
