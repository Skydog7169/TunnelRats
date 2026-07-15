// Item definitions — PLAIN DATA ONLY (Phase 1.5 Stage 3). Nothing consumes
// these yet except the lamp-choice migration; behavior arrives with timbers
// (Phase 2), the geophone (Phase 3), and the full armorer (Phase 4).

export type ItemId =
  | 'pick'
  | 'entrenching_tool'
  | 'timbers'
  | 'pistol'
  | 'knife'
  | 'geophone'
  | 'compass'
  | 'map'
  | 'lamp_head'
  | 'lamp_hip';

export interface ItemDef {
  id: ItemId;
  name: string; // display name
  stackSize: number; // max count per slot (1 = unstackable)
}

/**
 * Canonical item order — used for hashing and any future serialization.
 * APPEND ONLY: reordering or inserting changes every future state hash.
 */
export const ITEM_ORDER: ItemId[] = [
  'pick',
  'entrenching_tool',
  'timbers',
  'pistol',
  'knife',
  'geophone',
  'compass',
  'map',
  'lamp_head',
  'lamp_hip',
];

export const ITEMS: Record<ItemId, ItemDef> = {
  pick: { id: 'pick', name: 'Pick', stackSize: 1 },
  entrenching_tool: { id: 'entrenching_tool', name: 'Entrenching tool', stackSize: 1 },
  timbers: { id: 'timbers', name: 'Shoring timbers', stackSize: 20 },
  pistol: { id: 'pistol', name: 'Pistol', stackSize: 1 },
  knife: { id: 'knife', name: 'Trench knife', stackSize: 1 },
  geophone: { id: 'geophone', name: 'Geophone', stackSize: 1 },
  compass: { id: 'compass', name: 'Compass', stackSize: 1 },
  map: { id: 'map', name: 'Field map', stackSize: 1 },
  lamp_head: { id: 'lamp_head', name: 'Headlamp', stackSize: 1 },
  lamp_hip: { id: 'lamp_hip', name: 'Hip lamp', stackSize: 1 },
};
