// Flat tile colors (placeholder art pass). [r, g, b] 0-255.

import { Tile } from '../sim/tiles';

export const TILE_COLOR: Record<number, [number, number, number]> = {
  [Tile.Air]: [64, 56, 46], // lamplit tunnel air: warm haze so the beam is visible
  [Tile.Topsoil]: [110, 78, 48],
  [Tile.RootMat]: [92, 84, 34],
  [Tile.Clay]: [158, 108, 74],
  [Tile.Sand]: [194, 172, 106],
  [Tile.Chalk]: [214, 212, 198],
  [Tile.Rock]: [88, 90, 96],
  [Tile.Water]: [38, 74, 118],
  [Tile.Rubble]: [96, 82, 66],
  [Tile.Timber]: [140, 100, 40],
  [Tile.Ladder]: [125, 95, 56],
  [Tile.FlagPole]: [150, 148, 140], // weathered pole; flags stay neutral until Phase 4
};

export const SKY_COLOR = '#2a3138'; // grim overcast, WWI mood
