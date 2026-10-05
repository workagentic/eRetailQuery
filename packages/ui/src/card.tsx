import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type DivProps = HTMLAttributes<HTMLDivElement>;
export const Card = ({ className, ...p }: DivProps) => (
  <div
    className={cn('rounded-lg border border-border bg-background shadow-sm', className)}
    {...p}
  />
);
export const CardHeader = ({ className, ...p }: DivProps) => (
  <div className={cn('flex flex-col gap-1.5 p-6', className)} {...p} />
);
export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('text-lg font-semibold leading-none', className)} {...p} />
);
export const CardDescription = ({ className, ...p }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-sm text-muted-foreground', className)} {...p} />
);
export const CardContent = ({ className, ...p }: DivProps) => (
  <div className={cn('p-6 pt-0', className)} {...p} />
);
