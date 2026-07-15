// The deterministic simulation. Owns the world, the player, the RNG, and the
// tick counter. Consumes InputCommand structs only — never raw events, never
// wall-clock time. Same seed + same command stream = identical state.
import { InputCommand } from '../command';
import { CONFIG } from '../config';
import { PRNG } from '../core/prng';
import { cosDeg } from '../core/trig';
import { DynamicLight, LightSource } from './light';
import { Player } from './player';
import { World } from './world';
import { generateWorld, pointSpawn } from './worldgen';
export class Sim {
  readonly world: World;
  readonly player: Player;
  readonly rng: PRNG; // live-sim stream (worldgen used its own)
  tickCount = 0;
  private dynamicLight: DynamicLight;
  /**
   * `startPoint` (0–4, Stage 5 `?start=` playtest support) is a SIM INPUT
   * like the seed: it picks which capture point the soldier spawns/respawns
   * at. Sessions record it so replays reproduce. Default 0 = west home
   * trench (v1 gameplay; the golden test relies on this default).
   */
  constructor(
    readonly seed: number,
    readonly startPoint: number = 0,
  ) {
    this.world = new World();
    generateWorld(this.world, seed);
    this.rng = new PRNG(seed).fork(1);
    this.player = new Player(this.world, pointSpawn(this.world, startPoint));
    this.dynamicLight = new DynamicLight(this.world);
    this.updateLights();
  }
  step(cmd: InputCommand): void {
    this.player.tick(cmd);
    this.world.updateSunlight();
    this.updateLights();
    this.tickCount++;
  }
  private updateLights(): void {
    const L = CONFIG.light;
    const p = this.player;
    const sources: LightSource[] = [];
    if (!p.dead) {
      // Faint self-glow: you can always barely see yourself
      sources.push({
        x: p.centerX,
        y: p.centerY,
        range: L.selfGlowRange,
        intensity: L.selfGlowIntensity,
      });
      if (p.lampOn && p.carriedLamp === 'head') {
        sources.push({
          x: p.centerX,
          y: p.centerY,
          range: L.headlampRange,
          intensity: 1,
          dirX: p.facingX,
          dirY: p.facingY,
          coneCos: cosDeg(L.headlampConeDeg),
          coneSoftCos: cosDeg(L.headlampConeDeg + L.headlampConeSoftDeg),
        });
      }
      if (p.lampOn && p.carriedLamp === 'hip') {
        sources.push({
          x: p.centerX,
          y: p.centerY,
          range: L.hipLampRange,
          intensity: 0.85,
        });
      }
    }
    this.dynamicLight.update(sources);
  }
}
