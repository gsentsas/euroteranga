'use client';

import Link from 'next/link';
import type { ChangeEventHandler, ReactNode } from 'react';
import { OpsIcon, type OpsIconName } from './ops-icons';

export type OpsBreadcrumbItem = {
  label: string;
  href?: string;
};

export function OpsBreadcrumbs({ items }: { items: readonly OpsBreadcrumbItem[] }) {
  return (
    <nav className="ops-breadcrumbs" aria-label="Fil d’Ariane">
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`}>
              {index > 0 ? <OpsIcon name="chevron" /> : null}
              {item.href && !current ? (
                <Link href={item.href}>{item.label}</Link>
              ) : (
                <span aria-current={current ? 'page' : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function OpsPageHeader({
  title,
  subtitle,
  icon,
  group,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon: OpsIconName;
  group: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ops-page-header">
      <OpsBreadcrumbs items={[{ label: 'Accueil', href: '/' }, { label: title }]} />
      <div className="ops-page-header__row">
        <div className="ops-page-header__identity">
          <span className="ops-page-header__icon" aria-hidden="true">
            <OpsIcon name={icon} />
          </span>
          <div>
            <p className="ops-page-kicker">{group}</p>
            <h1>{title}</h1>
            {subtitle ? <p className="ops-page-subtitle">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="ops-page-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function OpsStatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return <span className={`ops-status-badge ops-status-badge--${tone}`}>{children}</span>;
}

export function OpsVersionBadge({ children }: { children: ReactNode }) {
  return <span className="ops-version-badge">{children}</span>;
}

type KpiProps = {
  label: string;
  value: ReactNode;
  helper?: ReactNode;
  icon: OpsIconName;
  tone?: StatusTone;
  href?: string;
};

function KpiContent({ label, value, helper, icon, tone = 'info' }: KpiProps) {
  return (
    <>
      <span className={`ops-kpi-card__icon ops-kpi-card__icon--${tone}`} aria-hidden="true">
        <OpsIcon name={icon} />
      </span>
      <span className="ops-kpi-card__body">
        <strong>{value}</strong>
        <span>{label}</span>
        {helper ? <small>{helper}</small> : null}
      </span>
    </>
  );
}

export function OpsKpiCard(props: KpiProps) {
  return props.href ? (
    <Link className="ops-kpi-card ops-kpi-card--link" href={props.href}>
      <KpiContent {...props} />
    </Link>
  ) : (
    <article className="ops-kpi-card">
      <KpiContent {...props} />
    </article>
  );
}

export function OpsToolbar({ children }: { children: ReactNode }) {
  return <div className="ops-toolbar">{children}</div>;
}

export function OpsFilterBar({
  children,
  label = 'Filtres',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="ops-filter-bar" aria-label={label}>
      {children}
    </section>
  );
}

export function OpsSearchInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) {
  return (
    <label className="ops-search-input">
      <span className="et-visually-hidden">{label}</span>
      <OpsIcon name="search" />
      <input type="search" value={value} placeholder={placeholder} onChange={onChange} />
    </label>
  );
}

export function OpsDataTable({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="ops-data-table">
      <table className="et-table">
        <caption className="et-visually-hidden">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export type OpsTab = { id: string; label: string };

export function OpsTabs({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: readonly OpsTab[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div className="ops-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = tabs.findIndex((candidate) => candidate.id === tab.id);
            const target =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            const next = tabs[target];
            if (!next) return;
            onSelect(next.id);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            buttons?.[target]?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function OpsActionMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="ops-action-menu">
      <summary aria-label={label}>•••</summary>
      <div>{children}</div>
    </details>
  );
}

export function OpsPagination({
  currentPage,
  totalPages,
  onPrevious,
  onNext,
}: {
  currentPage: number;
  totalPages: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="ops-pagination" aria-label="Pagination">
      <button type="button" onClick={onPrevious} disabled={currentPage <= 1}>
        Précédent
      </button>
      <span aria-live="polite">
        Page {currentPage} sur {Math.max(1, totalPages)}
      </span>
      <button type="button" onClick={onNext} disabled={currentPage >= totalPages}>
        Suivant
      </button>
    </nav>
  );
}
