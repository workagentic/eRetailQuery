'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A photo that falls back to `fallback` if it cannot load (offline, blocked, removed). The check on mount
 * catches images that failed before React attached its error handler.
 */
export function PhotoTile({
  src,
  className,
  fallback,
}: {
  src: string;
  className: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Pexels already serves the resized image
    <img
      ref={ref}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 object-cover ${className}`}
    />
  );
}
