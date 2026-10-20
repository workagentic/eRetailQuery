import { FlaskConical } from 'lucide-react';

export function DemoBanner() {
  return (
    <div
      role="note"
      className="flex items-center justify-center gap-2 border-b border-brand/20 bg-brand-soft px-4 py-2 text-center text-[13px] text-[#115e59]"
    >
      <FlaskConical aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      Demo data: a simulated business selling on Shopify and Amazon, not a real store. Photos are stock images from Pexels.
    </div>
  );
}
