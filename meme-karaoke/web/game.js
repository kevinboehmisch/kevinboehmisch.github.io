// Meme Karaoke in the browser: port of game.py (rules from specs.md), runs on laptops and phones.
//
// Player 1 is on the left, player 2 on the right: both halves of one (mirrored) camera ("local"),
// or one camera per device when playing online. Online, the device that opened the room ("host")
// runs the rules below and sends the state to the other one ("guest"), which only shows it and
// reports its own accuracy. Hits are compared by the seconds since the round started on each
// player's own device, so the network delay costs the guest nothing.
//
// Settings are URL parameters instead of environment variables, e.g. index.html?rounds=3&round_seconds=8
//   rounds [5]  round_seconds [6]  break_seconds [3]  start_seconds [3]  hit_seconds [2]
//   speed_seconds [0.5]  speed_threshold [0.7]  speed_points [2]
//   accuracy_threshold [0.7]  accuracy_points [8]  smoothing [1 = off]  announcer_delay [1]
// Online, the host's settings count.

import { bestMatchScore } from "./matching.js";
import { canvas, size } from "./media.js";

const params = new URLSearchParams(location.search);
const setting = (name, fallback) => Number(params.get(name) ?? fallback);

const ROUNDS = setting("rounds", 5);
const ROUND_SECONDS = setting("round_seconds", 6);
const BREAK_SECONDS = setting("break_seconds", 3);
const START_SECONDS = setting("start_seconds", 3);
const HIT_SECONDS = setting("hit_seconds", 2); // how long a hit is shown before the break
const ANNOUNCER_DELAY = setting("announcer_delay", 1); // end screen: announcer this long after fahhhhh starts
const SPEED_SECONDS = setting("speed_seconds", 0.5);
const SPEED_THRESHOLD = setting("speed_threshold", 0.7);
const SPEED_POINTS = setting("speed_points", 2);
const ACCURACY_THRESHOLD = setting("accuracy_threshold", 0.7);
const ACCURACY_POINTS = setting("accuracy_points", 8);
const SMOOTHING = setting("smoothing", 1); // 1 = raw score, lower = smoother but slower
const ONLINE_GRACE = 0.3; // online: seconds to wait for the other player's report before deciding a hit or the end of a round

export const WIDTH = 800, HEIGHT = 480; // size of the artwork (frame.png, player_0X.png)
export const DRAW_PICTURE = "../memes/movie_meme_013.png"; // shown in the frame on a draw
const FRAME_PICTURE_BOX = [262, 98, 274, 160]; // the colourful picture area inside frame.png
const WINNER_SHOT_BOX = [12, 108, 240, 360]; // winner's half of the camera (2:3), left of FATALITY
const MEME_BOX = [290, 300, 220, 165]; // x, y, w, h of the meme to copy, bottom center over the camera picture
const PLAYER_COLORS = ["rgb(40,160,255)", "rgb(255,60,60)"];
const GREEN = "rgb(0,220,0)";
const WHITE = "rgb(255,255,255)";
const YELLOW = "rgb(255,230,0)";
const ORANGE = "rgb(255,200,0)";
const HAND_COLOR = "rgb(0,200,255)";

/** Text centered at a point, with a dark outline so it reads on any background. Returns its width. */
function text(ctx, value, [x, y], scale, color = WHITE, thickness = 2) {
  ctx.font = `bold ${Math.round(scale * 30)}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = thickness + 4;
  ctx.strokeStyle = "black";
  ctx.strokeText(value, x, y);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
  return ctx.measureText(value).width;
}

/** Put an image into box [x, y, w, h]: fit inside it (letterbox) or fill it (crop).
 *  Returns a function that maps image pixels to canvas coordinates. */
function paste(ctx, image, [x, y, w, h], fill = false) {
  const [iw, ih] = size(image);
  const scale = (fill ? Math.max : Math.min)(w / iw, h / ih);
  if (fill) {
    const sw = w / scale, sh = h / scale, sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
    return (px, py) => [x + (px - sx) * scale, y + (py - sy) * scale];
  }
  const rw = iw * scale, rh = ih * scale, left = x + (w - rw) / 2, top = y + (h - rh) / 2;
  ctx.fillStyle = "black";
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(image, left, top, rw, rh);
  return (px, py) => [left + px * scale, top + py * scale];
}

function rect(ctx, x1, y1, x2, y2, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
}

function copy(source) {
  const [width, height] = size(source);
  const shot = canvas(width, height);
  shot.getContext("2d").drawImage(source, 0, 0);
  return shot;
}

// what the guest gets from the host, many times per second
const SYNCED = ["state", "round", "meme", "points", "accuracy", "roundPoints", "accuracyAwarded", "roundWinner", "lastRound", "config"];

export class Game {
  /** role: "local", "host" or "guest". me: the online player's number (0 or 1).
   *  view(player): {canvas, features} of that player's camera picture right now (canvas null if there is none). */
  constructor(memes, art, sound, { role = "local", me = null, view }) {
    this.memes = memes; // {name: {picture: Image, references: [...]}}
    this.art = art;
    this.sound = sound;
    this.role = role;
    this.me = me;
    this.view = view;
    this.lobby = { code: null, opponent: false }; // online: room code and whether the other player is there
    this.config = { rounds: ROUNDS, roundSeconds: ROUND_SECONDS, breakSeconds: BREAK_SECONDS, startSeconds: START_SECONDS };
    this.state = "attract";
    this.stateSince = performance.now() / 1000;
    this.points = [0, 0];
    this.round = 0;
    this.meme = null;
    this.lastRound = null; // [round number, points per player, winner or null] of the round just played
    this.roundWinner = null;
    this.winnerShots = [null, null]; // each player's camera picture at their last round win
    this.playlist = [];
    this.resetRound();
  }

  get online() {
    return this.role !== "local";
  }

  resetRound() {
    this.accuracy = [0, 0];
    this.speedAwarded = [false, false];
    this.accuracyAwarded = [false, false];
    this.roundPoints = [0, 0];
    this.hits = []; // {player, elapsed, accuracy} of players who reached the accuracy threshold
    this.hitDeadline = null;
  }

  /** Raw score of these features against the current meme. */
  rawScore(features) {
    return this.meme ? bestMatchScore(features, this.memes[this.meme].references) : 0;
  }

  enter(state, now) {
    this.state = state;
    this.stateSince = now;
    this.entered();
  }

  /** What happens on entering a state, on the host and the guest alike: sounds, the winner's photo. */
  entered() {
    const state = this.state;
    this.art.breakGif.hidden = state !== "break";
    console.log(`[${state}] round ${this.round}/${this.config.rounds}, points ${this.points[0]}:${this.points[1]}` +
      (state === "round" ? `, meme ${this.meme}` : ""));
    if (state === "countdown") this.winnerShots = [null, null];
    if (state === "round") this.sound.stop(); // no sound during a round
    if (state === "hit") {
      const picture = this.view(this.roundWinner).canvas;
      if (picture) this.winnerShots[this.roundWinner] = copy(picture);
      this.sound.playSequence(["round_win"]);
    }
    // nobody won the last round: always the tie sound first (the winner of a round had rizz already)
    const tie = this.lastRound && this.lastRound[2] === null ? ["round_tie"] : [];
    if (state === "break") this.sound.playSequence([...tie, "break"]);
    if (state === "game_over") {
      const winner = this.winner();
      if (winner !== null) {
        this.sound.playSequence([...tie, "match_win", `match_won_${winner + 1}`], [...tie.map(() => null), ANNOUNCER_DELAY, null]);
      } else {
        this.sound.playSequence([...tie, "match_draw"]);
      }
    }
  }

  start(now) {
    const names = Object.keys(this.memes).sort(() => Math.random() - 0.5);
    while (names.length < ROUNDS) { // fewer memes than rounds: repeat, but not twice in a row
      const extra = names[Math.floor(Math.random() * names.length)];
      if (extra !== names[names.length - 1] || new Set(names).size === 1) names.push(extra);
    }
    this.playlist = names.slice(0, ROUNDS);
    this.points = [0, 0];
    this.round = 1;
    this.meme = this.playlist[0];
    this.lastRound = null;
    this.enter("countdown", now);
  }

  /** Back to the start screen, e.g. when the online opponent left. */
  reset(now) {
    this.round = 0;
    this.meme = null;
    this.points = [0, 0];
    this.resetRound();
    this.enter("attract", now);
  }

  /** The rules (local and host). samples[player]: {raw, elapsed} measured in the current round, or null. */
  update(now, samples, startPressed) {
    const elapsed = now - this.stateSince;
    const grace = this.online ? ONLINE_GRACE : 0;
    if ((this.state === "attract" || this.state === "game_over") && startPressed && (!this.online || this.lobby.opponent)) {
      this.start(now);
    } else if ((this.state === "countdown" && elapsed >= START_SECONDS) || (this.state === "break" && elapsed >= BREAK_SECONDS)) {
      this.resetRound();
      this.enter("round", now);
    } else if (this.state === "round") {
      this.score(samples, now, grace);
      if (this.hits.length && now >= this.hitDeadline) {
        // the earliest hit wins; at the same time the more accurate one
        this.hits.sort((a, b) => a.elapsed - b.elapsed || b.accuracy - a.accuracy);
        this.roundWinner = this.hits[0].player;
        this.enter("hit", now);
      } else if (!this.hits.length && elapsed > ROUND_SECONDS + grace) {
        this.roundWinner = null;
        this.endRound(now);
      }
    } else if (this.state === "hit" && elapsed >= HIT_SECONDS) {
      this.endRound(now);
    }
  }

  endRound(now) {
    this.lastRound = [this.round, [...this.roundPoints], this.roundWinner];
    if (this.round >= ROUNDS) {
      this.enter("game_over", now);
    } else {
      this.round += 1;
      this.meme = this.playlist[this.round - 1];
      this.enter("break", now);
    }
  }

  /** Update accuracy and points from the players' newest samples; collects who reached the accuracy threshold. */
  score(samples, now, grace) {
    for (let player = 0; player < 2; player++) {
      const sample = samples[player];
      if (!sample) continue;
      this.accuracy[player] += SMOOTHING * (sample.raw - this.accuracy[player]);
      const accuracy = this.accuracy[player];
      if (!this.speedAwarded[player] && sample.elapsed <= SPEED_SECONDS && accuracy > SPEED_THRESHOLD) {
        this.speedAwarded[player] = true;
        this.points[player] += SPEED_POINTS;
        this.roundPoints[player] += SPEED_POINTS;
      }
      if (!this.accuracyAwarded[player] && sample.elapsed <= ROUND_SECONDS && accuracy >= ACCURACY_THRESHOLD) {
        this.accuracyAwarded[player] = true;
        this.points[player] += ACCURACY_POINTS;
        this.roundPoints[player] += ACCURACY_POINTS;
        this.hits.push({ player, elapsed: sample.elapsed, accuracy });
        this.hitDeadline ??= now + grace; // online: give the other player's report time to arrive
      }
    }
  }

  winner() {
    if (this.points[0] === this.points[1]) return null;
    return this.points[1] > this.points[0] ? 1 : 0;
  }

  /** Host: the state for the guest. */
  snapshot(now) {
    const snapshot = { elapsed: now - this.stateSince };
    for (const key of SYNCED) snapshot[key] = this[key];
    return snapshot;
  }

  /** Guest: take over the host's state. */
  apply(snapshot, now) {
    const changed = snapshot.state !== this.state || snapshot.round !== this.round;
    for (const key of SYNCED) this[key] = snapshot[key];
    if (changed) {
      this.stateSince = now - snapshot.elapsed;
      this.entered();
    }
  }

  render(ctx, now) {
    const elapsed = now - this.stateSince;
    const { rounds, roundSeconds, breakSeconds, startSeconds } = this.config;
    const canStart = !this.online || (this.role === "host" && this.lobby.opponent);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    if (this.state === "game_over") {
      const winner = this.winner();
      let scoreCenter;
      if (winner !== null) {
        if (this.art.win[winner]) paste(ctx, this.art.win[winner], [0, 0, WIDTH, HEIGHT]);
        // never hit a round, won on speed points: their picture right now
        const shot = this.winnerShots[winner] ?? this.view(winner).canvas;
        const [x, y, w, h] = WINNER_SHOT_BOX;
        rect(ctx, x - 4, y - 4, x + w + 4, y + h + 4, PLAYER_COLORS[winner]);
        if (shot) paste(ctx, shot, WINNER_SHOT_BOX, true);
        scoreCenter = [600, 330]; // right of the photo
      } else { // draw: frame.png with DRAW_PICTURE inside the frame
        if (this.art.frame) paste(ctx, this.art.frame, [0, 0, WIDTH, HEIGHT]);
        if (this.art.drawPicture) paste(ctx, this.art.drawPicture, FRAME_PICTURE_BOX, true);
        text(ctx, "DRAW", [WIDTH / 2, 175], 2.0, WHITE, 4);
        scoreCenter = [WIDTH / 2, 240];
      }
      const [x, y] = scoreCenter;
      const offset = text(ctx, `${this.points[0]} : ${this.points[1]}`, [x, y], 1.6, WHITE, 4) / 2 + 35;
      text(ctx, "P1", [x - offset, y], 0.9, PLAYER_COLORS[0], 2);
      text(ctx, "P2", [x + offset, y], 0.9, PLAYER_COLORS[1], 2);
      const hint = canStart ? "Tap for a new match" : this.lobby.opponent ? "Waiting for P1 to start a new match" : "Opponent left";
      text(ctx, hint, [winner !== null ? x : WIDTH / 2, HEIGHT - 25], 0.6, GREEN);
      return;
    }

    if (this.state === "break") { // the GIF full screen (an <img> behind the canvas), with the result of the round just played
      this.drawRoundResult(ctx);
      const startsIn = Math.max(1, Math.floor(breakSeconds - elapsed) + 1);
      text(ctx, `Round ${this.round} starts in ${startsIn}`, [WIDTH / 2, HEIGHT - 45], 1.3, YELLOW, 3);
      return;
    }

    this.drawCameras(ctx);
    if (this.state === "attract") {
      text(ctx, "MEME KARAOKE", [WIDTH / 2, 170], 1.3, YELLOW, 3);
      if (this.online) text(ctx, `Room ${this.lobby.code}`, [WIDTH / 2, 120], 0.7, WHITE);
      const hint = canStart ? "Tap to start" : !this.lobby.opponent ? "Waiting for an opponent ..." : "Waiting for P1 to start";
      if (!canStart || Math.floor(now * 2) % 2) text(ctx, hint, [WIDTH / 2, 225], 0.7, GREEN);
    } else if (this.state === "countdown") {
      const remaining = Math.max(1, Math.floor(startSeconds - elapsed) + 1);
      text(ctx, String(remaining), [WIDTH / 2, HEIGHT / 2], 4.0, WHITE, 8);
    } else if (this.state === "round" || this.state === "hit") {
      const [x, y, w, h] = MEME_BOX;
      rect(ctx, x - 4, y - 4, x + w + 4, y + h + 4, WHITE);
      const picture = this.memes[this.meme]?.picture;
      if (picture) paste(ctx, picture, MEME_BOX);
      if (this.state === "round") {
        const remaining = Math.max(0, roundSeconds - elapsed);
        text(ctx, remaining >= 1 ? remaining.toFixed(0) : remaining.toFixed(1), [WIDTH / 2, 40], 1.5, WHITE, 3);
      }
      text(ctx, `Round ${this.round}/${rounds}`, [WIDTH / 2, 80], 0.6);
    }
    if (this.state === "hit") {
      const left = this.roundWinner === 0 ? 0 : WIDTH / 2;
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 14;
      ctx.strokeRect(left + 6, 6, WIDTH / 2 - 13, HEIGHT - 13);
      text(ctx, "HIT!", [left + WIDTH / 4, 170], 2.6, GREEN, 6);
      text(ctx, `P${this.roundWinner + 1} WINS THE ROUND`, [left + WIDTH / 4, 235], 0.8, GREEN, 2);
    }
    this.drawPoints(ctx);
  }

  /** Each player's camera picture in their half: player 1 left, player 2 right. */
  drawCameras(ctx) {
    for (let player = 0; player < 2; player++) {
      const box = [player * WIDTH / 2, 0, WIDTH / 2, HEIGHT];
      const { canvas: picture, features } = this.view(player);
      if (!picture) {
        rect(ctx, box[0], 0, box[0] + box[2], HEIGHT, "rgb(25,25,25)");
        continue;
      }
      const toCanvas = paste(ctx, picture, box, true);
      ctx.save();
      ctx.beginPath();
      ctx.rect(...box);
      ctx.clip();
      ctx.fillStyle = HAND_COLOR;
      for (const hand of features?.hands ?? []) {
        for (const [px, py] of hand.pixels) {
          ctx.beginPath();
          ctx.arc(...toCanvas(px, py), 3, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    rect(ctx, WIDTH / 2 - 1, 0, WIDTH / 2 + 1, HEIGHT, WHITE);
  }

  drawRoundResult(ctx) {
    if (!this.lastRound) return;
    const [number, points, winner] = this.lastRound;
    const [label, color] = winner === null
      ? [`NOBODY WON ROUND ${number}`, WHITE]
      : [`P${winner + 1} WINS ROUND ${number}`, PLAYER_COLORS[winner]];
    rect(ctx, 0, 150, WIDTH, 330, "black");
    text(ctx, label, [WIDTH / 2, 200], 1.6, color, 3);
    text(ctx, `+${points[0]}`, [WIDTH / 2 - 150, 280], 1.4, PLAYER_COLORS[0], 3);
    text(ctx, `+${points[1]}`, [WIDTH / 2 + 150, 280], 1.4, PLAYER_COLORS[1], 3);
    text(ctx, `${this.points[0]} : ${this.points[1]}`, [WIDTH / 2, 280], 1.0);
  }

  drawPoints(ctx) {
    for (let player = 0; player < 2; player++) {
      const x = player === 0 ? 70 : WIDTH - 70;
      text(ctx, `P${player + 1}`, [x, 25], 0.8, PLAYER_COLORS[player]);
      text(ctx, String(this.points[player]), [x, 65], 1.5, PLAYER_COLORS[player], 3);
      if (player === this.me) text(ctx, "YOU", [x, 98], 0.5, PLAYER_COLORS[player]);
      if (this.state === "round" || this.state === "hit") this.drawBar(ctx, player);
    }
  }

  /** Live accuracy of one player: a bar with marks at the speed and accuracy thresholds. */
  drawBar(ctx, player) {
    const [left, right] = player === 0 ? [20, 270] : [WIDTH - 270, WIDTH - 20];
    const top = HEIGHT - 40, bottom = HEIGHT - 16;
    const accuracy = this.accuracy[player];
    const color = this.accuracyAwarded[player] || accuracy >= ACCURACY_THRESHOLD ? GREEN : PLAYER_COLORS[player];
    rect(ctx, left - 2, top - 2, right + 2, bottom + 2, "black");
    rect(ctx, left, top, right, bottom, "rgb(60,60,60)");
    rect(ctx, left, top, left + (right - left) * Math.min(accuracy, 1), bottom, color);
    for (const [threshold, mark] of [[SPEED_THRESHOLD, ORANGE], [ACCURACY_THRESHOLD, WHITE]]) {
      const x = left + (right - left) * threshold;
      rect(ctx, x - 1.5, top - 6, x + 1.5, bottom + 6, mark);
    }
    let label = `${(accuracy * 100).toFixed(0)} %`;
    if (this.roundPoints[player]) label += `  +${this.roundPoints[player]}`;
    text(ctx, label, [(left + right) / 2, top - 22], 0.9, color);
  }
}
