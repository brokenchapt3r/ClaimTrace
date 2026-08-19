import { cn } from '@/lib/utils';
import { forwardRef, type HTMLAttributes } from 'react';

export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  function Card({ className, ...props }, ref) {
    return <section ref={ref} className={cn('ct-card', className)} {...props} />;
  },
);

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn('ct-card-header', className)} {...props} />;
  },
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <h2 ref={ref} className={cn('ct-card-title', className)} {...props} />;
  },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('ct-card-content', className)} {...props} />;
  },
);
