import * as React from 'react';
import { cn } from '@/lib/utils';

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('overflow-y-auto', className)}
      {...props}
    >
      {children}
    </div>
  )
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
