import { CardSkeleton, ChartSkeleton, KpiSkeletonGrid, Skeleton, TableSkeleton } from "../ui";

export const BREAKEVEN_ASPECT = "1000 / 360";

/** Label/value list (e.g. budget variance, waste & savings). */
export function PairsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Horizontal bar list (label · bar · value), matching attribution rows. */
export function BarListSkeleton({ rows = 6 }: { rows?: number }) {
  const widths = ["w-full", "w-4/5", "w-3/5", "w-1/2", "w-2/5", "w-1/4", "w-1/5", "w-1/6"];
  return (
    <ul className="flex flex-col gap-2.5 p-5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="grid grid-cols-[minmax(9rem,15rem)_1fr_auto] items-center gap-3">
          <Skeleton className="h-3 w-32" />
          <div className="h-5"><Skeleton className={`h-5 ${widths[i % widths.length]}`} /></div>
          <Skeleton className="h-3 w-28" />
        </li>
      ))}
    </ul>
  );
}

export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

function LeagueBand({ rows }: { rows: number }) {
  return (
    <>
      <div className="flex h-8 items-center bg-black/[0.03] px-3"><Skeleton className="h-2.5 w-28" /></div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[41px] items-center gap-6 border-b border-line/70 px-3 last:border-b-0">
          <Skeleton className="h-3 w-48" />
          {Array.from({ length: 6 }).map((__, c) => <Skeleton key={c} className="ml-auto h-3 w-12" />)}
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </>
  );
}

/** ROI league body: column header, "top" band of 3 rows, divider, "other" band. */
export function LeagueSkeleton() {
  return (
    <div className="px-5 pb-5" aria-hidden="true">
      <div className="flex h-[33px] items-center gap-6 border-y border-line px-3">
        <Skeleton className="h-2.5 w-20" />
        {Array.from({ length: 7 }).map((_, c) => <Skeleton key={c} className="ml-auto h-2.5 w-14" />)}
      </div>
      <LeagueBand rows={3} />
      <div className="h-6 border-b-2 border-line-strong" />
      <LeagueBand rows={3} />
    </div>
  );
}

export function ExecutiveSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <KpiSkeletonGrid />
      <div className="tile ring-1 ring-line" aria-hidden="true">
        <div className="px-5 py-4"><Skeleton className="h-4 w-72" /></div>
        <LeagueSkeleton />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CardSkeleton action><ChartSkeleton aspectRatio={BREAKEVEN_ASPECT} /></CardSkeleton>
        <CardSkeleton><TableSkeleton rows={6} cols={3} /></CardSkeleton>
      </div>
    </div>
  );
}

export function SpendSkeleton() {
  return (
    <div className="space-y-4">
      <CardSkeleton action><ChartSkeleton height={240} /></CardSkeleton>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><CardSkeleton><TableSkeleton rows={7} cols={4} /></CardSkeleton></div>
        <div className="flex flex-col gap-4">
          <CardSkeleton><div className="space-y-2 p-5"><Skeleton className="h-7 w-20" /><Skeleton className="h-3 w-48" /></div></CardSkeleton>
          <CardSkeleton><PairsSkeleton rows={5} /></CardSkeleton>
        </div>
      </div>
      <CardSkeleton><TableSkeleton rows={4} cols={4} /></CardSkeleton>
      <InvocationsSkeleton />
      <GatewaySkeleton />
    </div>
  );
}

/** Raw invocations card: one page of 25 rows plus the pager. */
export function InvocationsSkeleton() {
  return (
    <CardSkeleton>
      <TableSkeleton rows={25} cols={8} />
      <div className="flex gap-2 px-5 py-3"><Skeleton className="h-6 w-12 rounded-lg" /><Skeleton className="h-6 w-12 rounded-lg" /></div>
    </CardSkeleton>
  );
}

/** Gateway telemetry: KPI strip + daily chart, destination-type bars, top destinations. */
export function GatewaySkeleton() {
  return (
    <div className="space-y-4">
      <CardSkeleton>
        <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2"><Skeleton className="h-2.5 w-16" /><Skeleton className="h-5 w-14" /></div>
          ))}
        </div>
        <ChartSkeleton height={160} />
      </CardSkeleton>
      <CardSkeleton><PairsSkeleton rows={3} /></CardSkeleton>
      <CardSkeleton><TableSkeleton rows={8} cols={5} /></CardSkeleton>
    </div>
  );
}

export function OrgTreeRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-3 py-2" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 py-1" style={{ paddingLeft: 8 + (i === 0 ? 0 : 16) }}>
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

export function OrgSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
      <CardSkeleton><OrgTreeRowsSkeleton /></CardSkeleton>
      <div className="flex flex-col gap-4">
        <CardSkeleton><StatRowSkeleton /></CardSkeleton>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CardSkeleton><TableSkeleton rows={6} cols={2} /></CardSkeleton>
          <CardSkeleton><ChartSkeleton height={180} /></CardSkeleton>
        </div>
      </div>
    </div>
  );
}

export function EfficiencySkeleton() {
  return (
    <div className="space-y-4">
      <CardSkeleton action><ChartSkeleton height={240} /></CardSkeleton>
      <CardSkeleton action>
        <div className="space-y-5 p-5" aria-hidden="true">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-8 w-40 rounded-lg" />
            <Skeleton className="h-4 w-12" />
          </div>
          <Skeleton className="h-56 w-full rounded-2xl" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      </CardSkeleton>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><CardSkeleton><TableSkeleton rows={6} cols={5} /></CardSkeleton></div>
        <CardSkeleton><PairsSkeleton rows={3} /></CardSkeleton>
      </div>
    </div>
  );
}

export function ProvenanceSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i}><PairsSkeleton rows={3} /></CardSkeleton>)}
      </div>
      <CardSkeleton><TableSkeleton rows={5} cols={4} /></CardSkeleton>
      <CardSkeleton action><TableSkeleton rows={4} cols={3} /></CardSkeleton>
      <CardSkeleton><TableSkeleton rows={3} cols={1} /></CardSkeleton>
    </div>
  );
}

export function UseCaseDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-3 w-16" />
      <div className="flex items-baseline gap-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-14" />
      </div>
      <KpiSkeletonGrid />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CardSkeleton><ChartSkeleton /></CardSkeleton>
        <CardSkeleton><ChartSkeleton aspectRatio={BREAKEVEN_ASPECT} /></CardSkeleton>
      </div>
      <CardSkeleton><PairsSkeleton rows={3} /></CardSkeleton>
    </div>
  );
}

export function EventListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start justify-between gap-3 py-2.5">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-3.5 w-14" />
        </div>
      ))}
    </div>
  );
}
