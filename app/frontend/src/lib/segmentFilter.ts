export type Sel = Set<string> | null;

export type SegmentSelection = {
  region: Sel;
  businessLine: Sel;
  legalEntity: Sel;
};

export type SegmentRow = {
  region: string;
  business_line: string;
  legal_entity_id: string;
};

export function allSegments(): SegmentSelection {
  return { region: null, businessLine: null, legalEntity: null };
}

export function segmentFilterActive(sel: SegmentSelection): boolean {
  return sel.region !== null || sel.businessLine !== null || sel.legalEntity !== null;
}

export function applySegmentFilter<T extends SegmentRow>(rows: T[], sel: SegmentSelection): T[] {
  const passes = (value: string, filter: Sel) => filter === null || filter.has(value);
  return rows.filter((row) =>
    passes(row.region, sel.region)
    && passes(row.business_line, sel.businessLine)
    && passes(row.legal_entity_id, sel.legalEntity));
}

export function segmentFilterSummary(filteredCount: number, totalCount: number, active: boolean): string {
  return active ? `${filteredCount} of ${totalCount} units` : "All units in scope";
}

export function activeSegmentCount(sel: SegmentSelection): number {
  return [sel.region, sel.businessLine, sel.legalEntity].filter((value) => value !== null).length;
}
