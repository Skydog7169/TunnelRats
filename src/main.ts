// Entry point: fixed-timestep loop. The sim ticks at CONFIG.sim.tickRate;
// the renderer runs at display refresh and interpolates. The only place
// wall-clock time exists. Also hosts the command recorder/replayer — the sim
// itself only ever consumes InputCommand structs, never knows the difference.

import { CONFIG } from './config';
import { InputManager } from './input';
import { VIEW_COUNT } from './render/debug';
import { Renderer } from './render/renderer';
import {
  deserializeCommand,
  downloadSession,
  isValidSession,
  serializeCommand,
  SerializedCommand,
  SessionV1,
} from './replay';
import { hashSimState } from './sim/hash';
import { Sim } from './sim/sim';

const params = new URLSearchParams(location.search);
const seedParam = params.get('seed');
// Wall-clock only picks the initial seed (outside the sim); the seed itself
// then fully determines the world.
const seed =
  seedParam !== null && seedParam !== ''
    ? Number(seedParam) >>> 0
    : (Date.now() % 1_000_000_000) >>> 0;

// ?start= capture-point spawn (Stage 5 playtest support). Accepts point2 /
// p2 / 2 and the named aliases. The value becomes a Sim INPUT (recorded in
// sessions), so replays reproduce regardless of the current URL.
function parseStart(raw: string | null): number {
  if (!raw) return 0;
  const s = raw.toLowerCase();
  const named: Record<string, number> = { west: 0, center: 2, crater: 2, east: 4 };
  if (s in named) return named[s];
  const n = Number(s.replace(/^point|^p/, ''));
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 0;
}
const startPoint = parseStart(params.get('start'));

const canvas = document.getElementById('game') as HTMLCanvasElement;
let sim = new Sim(seed, startPoint);
const renderer = new Renderer(canvas, sim);
const input = new InputManager(canvas);

// --- Recorder / replayer state (render-side; never visible to the sim) ------
let recording = false;
let recordedCommands: SerializedCommand[] = [];
let replay: { session: SessionV1; index: number } | null = null;

function setStatus(msg: string): void {
  renderer.debug.status = msg;
}

function startRecording(): void {
  // Recording must start from a reproducible state: restart the sim from the
  // same seed + start point at tick 0. (The world you dug is discarded — by design.)
  sim = new Sim(sim.seed, sim.startPoint);
  renderer.attachSim(sim);
  recordedCommands = [];
  recording = true;
  setStatus('● RECORDING (R to stop — world restarted from seed)');
}

function stopRecording(): SessionV1 {
  recording = false;
  const session: SessionV1 = {
    version: 1,
    seed: sim.seed,
    start: sim.startPoint,
    commands: recordedCommands,
    finalHash: hashSimState(sim),
  };
  setStatus(`recorded ${session.commands.length} ticks · hash ${session.finalHash}`);
  return session;
}

function startReplay(session: SessionV1): void {
  sim = new Sim(session.seed, session.start ?? 0);
  renderer.attachSim(sim);
  recording = false;
  replay = { session, index: 0 };
  setStatus(`▶ REPLAY 0/${session.commands.length}`);
}

function finishReplay(): void {
  if (!replay) return;
  const want = replay.session.finalHash;
  const got = hashSimState(sim);
  const ok = want === got;
  setStatus(
    ok
      ? `REPLAY OK — ${replay.session.commands.length} ticks, hash ${got}`
      : `REPLAY MISMATCH — expected ${want}, got ${got}`,
  );
  console.log(`[replay] ${ok ? 'OK' : 'MISMATCH'} expected=${want} got=${got}`);
  renderer.debug.lastHash = got;
  replay = null; // live input resumes
}

input.onToggleOverlay = () => (renderer.debug.overlayOn = !renderer.debug.overlayOn);
input.onCycleView = () => (renderer.debug.viewMode = (renderer.debug.viewMode + 1) % VIEW_COUNT);
input.onNewSeed = () => {
  const next = (Math.random() * 1_000_000_000) >>> 0; // outside the sim: fine
  location.search = `?seed=${next}${startPoint !== 0 ? `&start=${startPoint}` : ''}`;
};
input.onToggleRecord = () => {
  if (replay) return; // no recording while replaying
  if (recording) downloadSession(stopRecording());
  else startRecording();
};
input.onHashState = () => {
  const h = hashSimState(sim);
  renderer.debug.lastHash = h;
  console.log(`[hash] tick=${sim.tickCount} ${h}`);
};

// Drag-and-drop a session .json anywhere on the page to replay it
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!isValidSession(parsed)) {
      setStatus('drop rejected: not a v1 session file');
      return;
    }
    startReplay(parsed);
  } catch {
    setStatus('drop rejected: could not parse JSON');
  }
});

// Keep the seed (and any non-default start point) visible/shareable in the URL
if (seedParam === null) {
  history.replaceState(null, '', `?seed=${seed}${startPoint !== 0 ? `&start=${startPoint}` : ''}`);
}

const TICK_MS = 1000 / CONFIG.sim.tickRate;
let accumulator = 0;
let last = performance.now();

// FPS tracking (render frames)
let fpsFrames = 0;
let fpsLast = last;

function frame(now: number): void {
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // background-tab clamp; sim time simply pauses

  accumulator += dt;
  while (accumulator >= TICK_MS) {
    if (replay) {
      if (replay.index >= replay.session.commands.length) {
        finishReplay();
        continue; // fall through to live input on the next iteration
      }
      const cmd = deserializeCommand(replay.session.commands[replay.index++]);
      sim.step(cmd);
      if (replay && replay.index % 30 === 0) {
        setStatus(`▶ REPLAY ${replay.index}/${replay.session.commands.length}`);
      }
      if (replay && replay.index >= replay.session.commands.length) finishReplay();
    } else {
      const aim = renderer.screenToWorld(input.mouseSx, input.mouseSy);
      const cmd = input.buildCommand(aim);
      if (recording) recordedCommands.push(serializeCommand(cmd));
      sim.step(cmd);
    }
    accumulator -= TICK_MS;
  }

  fpsFrames++;
  if (now - fpsLast >= 500) {
    renderer.debug.fps = (fpsFrames * 1000) / (now - fpsLast);
    fpsFrames = 0;
    fpsLast = now;
  }

  renderer.render(accumulator / TICK_MS, input.mouseSx, input.mouseSy, dt / 1000);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Dev-console handle for debugging/verification only. Nothing in the game
// reads this; the sim still only consumes InputCommands.
(window as any).__tunnelRats = {
  get sim() {
    return sim;
  },
  renderer,
  hashSimState: () => hashSimState(sim),
  startRecording,
  stopRecording, // returns the session object without downloading
  startReplay,
  get replayActive() {
    return replay !== null;
  },
};
