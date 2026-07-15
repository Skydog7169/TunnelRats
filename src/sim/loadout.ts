// Loadout: the soldier's carry slots (Phase 1.5 Stage 3 — data model only).
// Sim-owned state: registered in the state hash. The armorer UI and item
// behaviors arrive in later phases; today only the lamp choice lives here.

import { CONFIG } from '../config';
import { StateHasher } from './hash';
import { ItemId, ITEM_ORDER } from './items';

export interface Slot {
  item: ItemId;
  count: number;
}

export class Loadout {
  slots: (Slot | null)[];

  constructor() {
    this.slots = Array.from({ length: CONFIG.player.loadoutSlots }, () => null);
  }

  /** Index of the slot holding this item, or -1. */
  findSlot(item: ItemId): number {
    return this.slots.findIndex((s) => s !== null && s.item === item);
  }

  has(item: ItemId): boolean {
    return this.findSlot(item) >= 0;
  }

  /** Put an item in the first empty slot. Returns false if full. */
  add(item: ItemId, count = 1): boolean {
    const i = this.slots.findIndex((s) => s === null);
    if (i < 0) return false;
    this.slots[i] = { item, count };
    return true;
  }

  /** Swap the contents of the slot holding `from` for `to` (same slot index). */
  swapItem(from: ItemId, to: ItemId, count = 1): boolean {
    const i = this.findSlot(from);
    if (i < 0) return false;
    this.slots[i] = { item: to, count };
    return true;
  }

  hashState(h: StateHasher): void {
    h.u32(this.slots.length);
    for (const s of this.slots) {
      if (s === null) {
        h.byte(0);
        h.u32(0);
      } else {
        h.byte(ITEM_ORDER.indexOf(s.item) + 1); // canonical order: append-only!
        h.u32(s.count);
      }
    }
  }
}
