/**
 * FMCSA census vocabulary: how a cargo type is stored on data.transportation.gov
 * and how to read the shipment / equipment fields back.
 *
 * Cargo is published as one `crgo_*` flag column per type, where "X" means the
 * carrier answered that box on the MCS-150. Equipment is published as counts, so
 * a truck/tractor is a number greater than zero in `owntract`, `trmtract` or
 * `trptract` (owned, term-leased, trip-leased).
 */

export interface CargoType {
  /** Value used in the UI and in saved filter profiles. */
  id: string;
  label: string;
  /** Column on the Company Census File (az4n-8mr2). */
  column: string | null;
}

/**
 * Order follows the MCS-150 form. "Other" has no column: the carrier's free-text
 * description is unmatched and is never counted as an exclusion.
 */
export const CARGO_TYPES: readonly CargoType[] = [
  { id: 'general', label: 'General Freight', column: 'crgo_genfreight' },
  { id: 'household', label: 'Household Goods', column: 'crgo_household' },
  { id: 'metal', label: 'Metal: Sheets, Coils, Rolls', column: 'crgo_metalsheet' },
  { id: 'vehicles', label: 'Motor Vehicles', column: 'crgo_motoveh' },
  { id: 'driveaway', label: 'Drive/Tow Away', column: 'crgo_drivetow' },
  { id: 'logs', label: 'Logs, Poles, Beams, Lumber', column: 'crgo_logpole' },
  { id: 'building', label: 'Building Materials', column: 'crgo_bldgmat' },
  { id: 'mobilehome', label: 'Mobile Homes', column: 'crgo_mobilehome' },
  { id: 'machinery', label: 'Machinery, Large Objects', column: 'crgo_machlrg' },
  { id: 'produce', label: 'Fresh Produce', column: 'crgo_produce' },
  { id: 'liquids', label: 'Liquids/Gases', column: 'crgo_liqgas' },
  { id: 'intermodal', label: 'Intermodal Containers', column: 'crgo_intermodal' },
  { id: 'passengers', label: 'Passengers', column: 'crgo_passengers' },
  { id: 'oilfield', label: 'Oilfield Equipment', column: 'crgo_oilfield' },
  { id: 'livestock', label: 'Livestock', column: 'crgo_livestock' },
  { id: 'grain', label: 'Grain, Feed, Hay', column: 'crgo_grainfeed' },
  { id: 'coal', label: 'Coal, Coke', column: 'crgo_coalcoke' },
  { id: 'meat', label: 'Meat', column: 'crgo_meat' },
  { id: 'garbage', label: 'Garbage, Refuse, Trash', column: 'crgo_garbage' },
  { id: 'usmail', label: 'U.S. Mail', column: 'crgo_usmail' },
  { id: 'chemicals', label: 'Chemicals', column: 'crgo_chem' },
  { id: 'drybulk', label: 'Commodities Dry Bulk', column: 'crgo_drybulk' },
  { id: 'coldfood', label: 'Refrigerated Food', column: 'crgo_coldfood' },
  { id: 'beverages', label: 'Beverages', column: 'crgo_beverages' },
  { id: 'paper', label: 'Paper Products', column: 'crgo_paperprod' },
  { id: 'utility', label: 'Utility', column: 'crgo_utility' },
  { id: 'farmsupply', label: 'Farm Supplies', column: 'crgo_farmsupp' },
  { id: 'construction', label: 'Construction', column: 'crgo_construct' },
  { id: 'waterwell', label: 'Water Well', column: 'crgo_waterwell' },
  { id: 'other', label: 'Other', column: null },
];

const BY_ID = new Map(CARGO_TYPES.map((type) => [type.id, type]));

const COLUMN_BY_ID = new Map(
  CARGO_TYPES.filter((type) => type.column).map((type) => [type.id, type.column as string]),
);

/** Accepts an id, a label or a loose spelling ("Household Goods", "household"). */
export function normaliseCargo(input: string): CargoType | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const asId = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byId = CARGO_TYPES.find(
    (type) => type.id === asId || type.label.toLowerCase().replace(/[^a-z0-9]+/g, '') === asId,
  );
  if (byId) return byId;

  const lower = raw.toLowerCase();
  return (
    CARGO_TYPES.find((type) => type.label.toLowerCase() === lower) ??
    CARGO_TYPES.find((type) => lower.split(/[^a-z]+/).includes(type.id)) ??
    null
  );
}

export function parseCargoList(input: readonly string[] | string): string[] {
  const tokens = Array.isArray(input) ? input : String(input ?? '').split(',');
  const ids = new Set<string>();
  for (const token of tokens) {
    const type = normaliseCargo(token);
    if (type) ids.add(type.id);
  }
  return CARGO_TYPES.filter((type) => ids.has(type.id)).map((type) => type.id);
}

export function cargoLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/**
 * SoQL predicate that excludes carriers who answered X for any of `ids`.
 * "Other" has no column, so it never excludes anything — it is reported in the
 * UI summary instead of being silently dropped.
 */
export function cargoExclusionClause(ids: readonly string[]): string | null {
  const columns = ids.map((id) => COLUMN_BY_ID.get(id)).filter((column): column is string => Boolean(column));
  if (columns.length === 0) return null;
  return columns.map((column) => `(${column} is null or ${column} != 'X')`).join(' and ');
}

/**
 * Equipment predicate: "must show a truck/tractor" means an owned or leased
 * tractor count above zero on the census record.
 */
export const TRUCK_TRACTOR_CLAUSE = "(owntract > '0' or trmtract > '0' or truck_units > '0')";

/** Census operation code -> the two words the export column uses. */
export function operationLabel(code: string | null | undefined): string | null {
  const value = String(code ?? '')
    .trim()
    .toUpperCase();
  if (!value) return null;
  if (value === 'A') return 'Interstate';
  if (value === 'B' || value === 'C') return 'Intrastate';
  return null;
}

export interface EquipmentCounts {
  trucks: number | null;
  tractors: number | null;
  trailers: number | null;
}

/**
 * "Truck Trailers" column: tractors first because that is what pulls a trailer,
 * then trailers, then straight trucks. Zero is a real answer and is rendered as
 * such, but an entirely empty set becomes blank instead of a made-up 0.
 */
export function equipmentSummary(counts: EquipmentCounts): string | null {
  const { trucks, tractors, trailers } = counts;
  if (trucks === null && tractors === null && trailers === null) return null;

  const parts: string[] = [];
  if (tractors) parts.push(`${tractors} tractor${tractors === 1 ? '' : 's'}`);
  if (trailers) parts.push(`${trailers} trailer${trailers === 1 ? '' : 's'}`);
  if (trucks) parts.push(`${trucks} truck${trucks === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'No equipment reported';
  return parts.join(' · ');
}

/** Cargo ids answered "X" on the census record, in MCS-150 order. */
export function cargoFromRow(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const type of CARGO_TYPES) {
    if (!type.column) continue;
    if (String(row[type.column] ?? '').trim().toUpperCase() === 'X') out.push(type.id);
  }
  return out;
}
