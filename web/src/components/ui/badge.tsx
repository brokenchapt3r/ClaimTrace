import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'destructive' | 'outline';

type BadgeProps = HTMLAttributes<HTMLDivElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn('ct-badge', `ct-badge-${variant}`, className)}
      {...props}
    />
  );
}
