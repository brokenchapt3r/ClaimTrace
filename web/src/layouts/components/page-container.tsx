import { cn } from '@/lib/utils';
import type { HTMLAttributes, PropsWithChildren } from 'react';

export function PageContainer({
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <div className={cn('ct-page-container', className)} {...props} />;
}
