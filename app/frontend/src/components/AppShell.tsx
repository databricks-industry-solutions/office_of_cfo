import { ReactNode } from "react";
import { cn } from "../lib/cn";
import { LayoutMode, shellContainerClass } from "../lib/pageLayout";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-[100dvh] flex flex-col overflow-x-hidden">
      <a href="#main-content" className="skip-link">Skip to content</a>
      {children}
    </div>
  );
}

export function ShellContainer({
  mode = "wide",
  className,
  children,
}: {
  mode?: LayoutMode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(shellContainerClass(mode), className)}>
      {children}
    </div>
  );
}

export function PageViewport({
  mode,
  children,
}: {
  mode: LayoutMode;
  children: ReactNode;
}) {
  return (
    <ShellContainer mode={mode} className="flex-1 min-h-0 flex flex-col py-6">
      {children}
    </ShellContainer>
  );
}

export function DashboardGrid({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("dashboard-grid", className)}>{children}</div>;
}
