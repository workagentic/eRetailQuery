import type { ReactNode } from 'react';

/** Page title with a one-line description and optional actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** A white panel with an optional title, description and right-hand action. */
export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[14px] border border-border/70 bg-surface shadow-[var(--shadow-card)] ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>}
            {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** A gentle in-page notice (cost data incomplete, generic bands). */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-xl border border-warn/25 bg-warn-soft px-4 py-3 text-sm text-[#7c3d06]">
      {children}
    </p>
  );
}
