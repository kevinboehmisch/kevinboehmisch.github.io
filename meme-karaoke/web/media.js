// Camera, detection and sound for the browser version: LiveDetector and Sound are the web
// counterparts of matching.py's LiveDetector and sound.py.

import { extractFeatures } from "./matching.js";

const params = new URLSearchParams(location.search);
const DELEGATE = params.get("delegate") ?? "GPU"; // CPU if the GPU does not work on a device

// local copies (python web/build.py) or else the CDN; version as in build.py
const MEDIAPIPE = ["vendor", "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"];
const MODELS = {
  face: ["../models/face_landmarker.task", "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"],
  hand: ["../models/hand_landmarker.task", "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"],
};

const SOUNDS = {
  break: "../audios/fellas.mp3", // between rounds
  round_win: "../audios/rizz.mp3", // the moment a player hits
  round_tie: "../audios/fart-boom.mp3", // nobody won the round
  match_win: "../audios/fahhhhh.mp3", // end screen with a winner
  match_draw: "../audios/sigma.mp3", // end screen, draw
  match_won_1: "../audios/announcer_match_won_1.wav",
  match_won_2: "../audios/announcer_match_won_2.wav",
};

export const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

export function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export function size(image) {
  return [image.naturalWidth || image.videoWidth || image.width, image.naturalHeight || image.videoHeight || image.height];
}

export function canvas(width, height) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}

function resize(element, width, height) {
  if (element.width !== width || element.height !== height) {
    element.width = width;
    element.height = height;
  }
}

/** The MediaPipe library and the folder of its runtime: the local copy, else the CDN. */
async function loadMediaPipe() {
  for (const base of MEDIAPIPE) {
    try {
      return { library: await import(`${base.startsWith("http") ? base : "./" + base}/vision_bundle.mjs`), wasm: `${base}/wasm` };
    } catch (error) {
      console.log(`MediaPipe not at ${base}`);
    }
  }
  throw new Error("Cannot load MediaPipe: no internet and no local copy (python web/build.py)");
}

/** The model file as bytes: the local copy, else the download. */
async function loadModel(urls) {
  for (const url of urls) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return new Uint8Array(await response.arrayBuffer());
    console.log(`Model not at ${url}`);
  }
  throw new Error(`Cannot load the model ${urls[0]}`);
}

/** Everything the detector needs, started right away so it loads while the menu is shown. */
export async function loadRuntime() {
  const [{ library, wasm }, face, hand] = await Promise.all([loadMediaPipe(), loadModel(MODELS.face), loadModel(MODELS.hand)]);
  return { library, vision: await library.FilesetResolver.forVisionTasks(wasm), face, hand };
}

/** A video drawn mirrored into a canvas, the way the players see themselves. */
export class MirroredVideo {
  constructor(video) {
    this.video = video;
    this.canvas = canvas(1, 1);
    this.lastTime = -1;
  }

  get ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Draws the newest video frame; returns false if there is none since the last call. */
  update() {
    if (!this.ready || this.video.currentTime === this.lastTime) return false;
    this.lastTime = this.video.currentTime;
    const [width, height] = size(this.video);
    resize(this.canvas, width, height);
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(-1, 0, 0, 1, width, 0);
    ctx.drawImage(this.video, 0, 0, width, height);
    return true;
  }
}

/** Detection like LiveDetector in matching.py: players = 2 splits the mirrored camera into a left and a
 *  right half, each with its own face and hand model (VIDEO mode tracks from frame to frame). */
export class LiveDetector {
  static async create(runtime, players) {
    const { FaceLandmarker, HandLandmarker } = runtime.library;
    const make = async (delegate) => {
      const models = [];
      for (let player = 0; player < players; player++) {
        models.push({
          face: await FaceLandmarker.createFromOptions(runtime.vision, {
            baseOptions: { modelAssetBuffer: runtime.face.slice(), delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
          }),
          hand: await HandLandmarker.createFromOptions(runtime.vision, {
            baseOptions: { modelAssetBuffer: runtime.hand.slice(), delegate },
            runningMode: "VIDEO",
            numHands: 2,
          }),
        });
      }
      return models;
    };
    try {
      return new LiveDetector(players, await make(DELEGATE));
    } catch (error) {
      if (DELEGATE === "CPU") throw error;
      console.warn("GPU delegate failed, using CPU", error);
      return new LiveDetector(players, await make("CPU"));
    }
  }

  constructor(players, models) {
    this.players = players;
    this.models = models;
    this.halves = models.map(() => canvas(1, 1)); // each player's part of the mirrored frame
    this.results = models.map(() => ({ face: null, hand: null, time: 0, size: [1, 1] }));
    this.lastTimestamp = 0;
    this.turn = 0;
  }

  /** Detect on a new mirrored camera frame. With 2 players they take turns (one per frame), which halves the work on phones. */
  update(mirror, now) {
    this.mirror = mirror;
    const player = this.turn++ % this.players;
    const region = this.region(player);
    const timestamp = (this.lastTimestamp = Math.max(performance.now(), this.lastTimestamp + 1));
    this.results[player] = {
      face: this.models[player].face.detectForVideo(region, timestamp),
      hand: this.models[player].hand.detectForVideo(region, timestamp),
      time: now,
      size: [region.width, region.height],
    };
  }

  /** The part of the mirrored frame that belongs to this player. */
  region(player) {
    if (this.players === 1) return this.mirror;
    const half = this.halves[player];
    const width = Math.floor(this.mirror.width / 2), height = this.mirror.height;
    resize(half, width, height);
    half.getContext("2d").drawImage(this.mirror, player === 0 ? 0 : width, 0, width, height, 0, 0, width, height);
    return half;
  }

  /** Newest features of this player (pixels relative to their region), or null.
   *  since: only use detections of camera frames taken at or after this time. */
  features(player, since = 0) {
    const result = this.results[player];
    if (!result.face || !result.hand || result.time < since) return null;
    return extractFeatures(result.face, result.hand, ...result.size);
  }
}

/** Sound effects with the Web Audio API (also works on iPhones once the player has tapped). */
export class Sound {
  constructor() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.buffers = {};
    this.source = null;
    this.sequence = 0; // increases with every play/stop, so an old sequence stops
    for (const [name, url] of Object.entries(SOUNDS)) {
      fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => this.context.decodeAudioData(data))
        .then((buffer) => (this.buffers[name] = buffer))
        .catch((error) => console.warn(`Sound: cannot load ${url}`, error));
    }
  }

  /** Browsers only allow sound after a tap or key press: call this in the input handler. */
  unlock() {
    if (this.context.state !== "running") this.context.resume();
  }

  /** Play these sounds one after the other (missing ones are skipped). Stops what was playing.
   *  waits: per sound, seconds after its start when the next one starts and cuts it off. */
  async playSequence(names, waits = []) {
    this.stop();
    const sequence = this.sequence;
    for (const [i, name] of names.entries()) {
      const buffer = this.buffers[name];
      if (sequence !== this.sequence) return;
      if (!buffer) continue;
      this.stopSource();
      this.source = this.context.createBufferSource();
      this.source.buffer = buffer;
      this.source.connect(this.context.destination);
      this.source.start();
      await sleep(waits[i] ?? buffer.duration);
    }
  }

  stopSource() {
    if (this.source) {
      try {
        this.source.stop();
      } catch {}
      this.source = null;
    }
  }

  stop() {
    this.sequence++;
    this.stopSource();
  }
}
