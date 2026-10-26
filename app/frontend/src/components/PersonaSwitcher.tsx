import { OrgTree, Persona, Scope, ScopeType } from "../api";
import { Select, SelectOption } from "./ui";

interface ScopeOption {
  type: ScopeType;
  id: string;
  label: string;
  group: string;
}

export function scopeOptions(persona: Persona | null, org: OrgTree | null): ScopeOption[] {
  if (!persona || !org || persona.scope_locked) return [];
  const opts: ScopeOption[] = [];
  const wants = (t: ScopeType) => persona.scope_type === t;
  // Controllers can view a geography OR a business line; accountants a BU; etc.
  if (wants("region")) {
    for (const r of org.regions) opts.push({ type: "region", id: r.region, label: r.region, group: "Region" });
    for (const r of org.regions)
      for (const le of r.legal_entities)
        opts.push({ type: "legal_entity", id: le.legal_entity_id, label: le.legal_entity_name, group: "Legal entity" });
    for (const bl of org.business_lines)
      opts.push({ type: "business_line", id: bl, label: bl, group: "Business line" });
  } else if (wants("legal_entity")) {
    for (const r of org.regions)
      for (const le of r.legal_entities)
        opts.push({ type: "legal_entity", id: le.legal_entity_id, label: le.legal_entity_name, group: "Legal entity" });
  } else if (wants("business_unit")) {
    for (const u of org.units)
      opts.push({ type: "business_unit", id: u.business_unit_id, label: `${u.business_unit_name} (${u.business_unit_id})`, group: "Business unit" });
  }
  return opts;
}

export function scopeLabel(scope: Scope, org: OrgTree | null): string {
  if (scope.scope_type === "consolidated") return "Consolidated · all geographies";
  const u = org?.units.find((x) => x.business_unit_id === scope.scope_id);
  if (scope.scope_type === "business_unit") return u ? `${u.business_unit_name}` : scope.scope_id;
  if (scope.scope_type === "legal_entity") {
    for (const r of org?.regions ?? [])
      for (const le of r.legal_entities)
        if (le.legal_entity_id === scope.scope_id) return le.legal_entity_name;
  }
  return scope.scope_id;
}

// Org-scope filter for the topbar: narrows the current view to a region /
// legal entity / business unit, depending on what the active persona allows.
// Persona identity switching now lives in the sidebar footer (PersonaMenu).
export default function ScopeSwitcher({
  persona, org, scope, onScope,
}: {
  persona: Persona | null;
  org: OrgTree | null;
  scope: Scope;
  onScope: (s: Scope) => void;
}) {
  const opts = scopeOptions(persona, org);
  const scopeValue = `${scope.scope_type}:${scope.scope_id}`;

  if (opts.length === 0) return null;

  const selectOptions: SelectOption[] = opts.map((o) => ({
    value: `${o.type}:${o.id}`,
    label: o.label,
    group: o.group,
  }));

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-subtle hidden md:inline">Scope</span>
      <Select
        aria-label="Select org scope"
        size="sm"
        value={scopeValue}
        options={selectOptions}
        onChange={(v) => {
          const [type, id] = v.split(":");
          onScope({ scope_type: type as ScopeType, scope_id: id });
        }}
        className="max-w-[220px]"
      />
    </div>
  );
}
