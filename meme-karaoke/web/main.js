// Menu and wiring of the browser version: play on this device (two players, one camera) or online
// (each player on their own device with their own camera, see online.js). Rules and drawing: game.js.
//
// Online links: ?join=CODE joins a room as player 2; the host's page keeps ?host=CODE, so a reload
// opens the same room again.

import { DRAW_PICTURE, Game, HEIGHT, WIDTH } from "./game.js";
import { LiveDetector, MirroredVideo, Sound, loadImage, loadRuntime } from "./media.js";
import { Peer, TRANSPORT, newRoomCode, onlineAvailable, openRoom } from "./online.js";

const PIXEL_RATIO = 2; // canvas drawn at 2x, so text stays sharp on big screens
const HELLO_SECONDS = 2; // guest: how often to knock until the host answers
const STATE_RATE = 30; // host: state updates per second to the guest

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const seconds = () => performance.now() / 1000;
const id = Math.random().toString(36).slice(2, 10); // this page in the room

// load everything right away, while the menu is shown
const runtime = loadRuntime();
runtime.catch(() => {}); // reported when it is needed
const sound = new Sound();
const assets = (async () => {
  const data = await (await fetch("references.json")).json();
  const memes = {};
  await Promise.all(Object.entries(data).map(async ([name, meme]) => {
    memes[name] = { picture: await loadImage(meme.picture), references: meme.references };
  }));
  if (!Object.keys(memes).length) throw new Error("No references: run python web/build.py");
  const art = { breakGif: $("break") };
  [art.frame, art.drawPicture, ...art.win] = await Promise.all(
    ["../frame.png", DRAW_PICTURE, "../player_01.png", "../player_02.png"].map(loadImage),
  );
  return { memes, art };
})();
assets.catch(() => {});

/** Online games send the camera picture to the other player: ask every time, nothing is stored. */
function askConsent(start) {
  $("menu").hidden = true;
  $("consent").hidden = false;
  $("consent-accept").onclick = () => {
    $("consent").hidden = true;
    start();
  };
  $("consent-back").onclick = () => {
    $("consent").hidden = true;
    $("menu").hidden = false;
  };
}

function showMenu() {
  const join = params.get("join"), host = params.get("host");
  document.documentElement.lang = navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
  $("menu").hidden = false;
  $("local").onclick = () => play("local");
  if (!onlineAvailable()) {
    $("create").disabled = true;
    $("menu-note").textContent = "Online play needs a Supabase project, see web/config.js.";
  }
  $("create").onclick = () => askConsent(() => play("host", host ?? newRoomCode()));
  if (join) {
    $("join").hidden = false;
    $("join").querySelector("span").textContent = join;
    $("join").onclick = () => askConsent(() => play("guest", join));
  }
}

/** Start the game: camera, detection, and for online games the room. */
async function play(role, code) {
  sound.unlock(); // the click allows sound from now on
  if (matchMedia("(pointer: coarse)").matches && !document.fullscreenElement) { // phones: full screen, landscape
    document.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.("landscape")).catch(() => {});
  }
  $("menu").hidden = true;
  const status = $("status");
  status.hidden = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("No camera access: open the page over https:// (or http://localhost).");
    status.textContent = "Starting camera ...";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    status.textContent = "Loading ...";
    const [{ memes, art }, loaded] = await Promise.all([assets, runtime]);
    status.textContent = "Starting models ...";
    const detector = await LiveDetector.create(loaded, role === "local" ? 2 : 1);
    const camera = new MirroredVideo(video);
    if (role === "local") playLocal(camera, detector, memes, art);
    else await playOnline(role, code, stream, camera, detector, memes, art);
    status.hidden = true;
  } catch (error) {
    console.error(error);
    status.textContent = error.name === "NotAllowedError" ? "Camera access was denied." : error.message;
  }
}

/** Taps, clicks, Space and Enter start the game; not the ones on the menu or the invite bar. */
function onPress(handler) {
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#menu, #share, #consent")) handler();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") handler();
  });
}

function runLoop(frame) {
  const screen = $("screen");
  screen.width = WIDTH * PIXEL_RATIO;
  screen.height = HEIGHT * PIXEL_RATIO;
  const ctx = screen.getContext("2d");
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  const step = () => {
    frame(ctx, seconds());
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Two players in front of one camera: left half player 1, right half player 2. */
function playLocal(camera, detector, memes, art) {
  const started = () => camera.lastTime >= 0;
  const game = new Game(memes, art, sound, {
    view: (player) => (started() ? { canvas: detector.region(player), features: detector.features(player) } : { canvas: null }),
  });
  let startPressed = false;
  onPress(() => {
    sound.unlock();
    startPressed = true;
  });
  runLoop((ctx, now) => {
    if (camera.update()) detector.update(camera.canvas, now);
    const samples = [0, 1].map((player) =>
      game.state === "round" && started()
        ? { raw: game.rawScore(detector.features(player, game.stateSince)), elapsed: now - game.stateSince }
        : null);
    game.update(now, samples, startPressed);
    startPressed = false;
    game.render(ctx, now);
  });
}

/** One player on this device; the room's host is player 1 and runs the rules, the guest is player 2. */
async function playOnline(role, code, stream, camera, detector, memes, art) {
  const me = role === "host" ? 0 : 1;
  const remoteVideo = document.createElement("video");
  remoteVideo.className = "hidden-video";
  remoteVideo.playsInline = remoteVideo.muted = remoteVideo.autoplay = true;
  document.body.append(remoteVideo);
  const remote = new MirroredVideo(remoteVideo); // the opponent mirrored too, as they see themselves

  let peer = null;
  const game = new Game(memes, art, sound, {
    role,
    me,
    view: (player) => {
      if (player === me) return camera.lastTime >= 0 ? { canvas: camera.canvas, features: detector.features(0) } : { canvas: null };
      return peer?.open && remote.lastTime >= 0 ? { canvas: remote.canvas, features: null } : { canvas: null };
    },
  });
  game.lobby.code = code;

  // the page's own address and the invite link (keeping ?transport=tabs and the settings)
  const url = new URL(location.href);
  url.searchParams.delete("join");
  url.searchParams.delete("host");
  const invite = new URL(url);
  invite.searchParams.set("join", code);
  if (role === "host") {
    url.searchParams.set("host", code);
    history.replaceState(null, "", url);
  }
  $("share-link").textContent = invite.href;
  $("share-button").onclick = async () => {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "Meme Karaoke", text: `Play Meme Karaoke with me, room ${code}`, url: invite.href }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(invite.href);
      $("share-button").textContent = "Copied!";
    }
  };

  const connect = (other, session) => {
    peer?.close();
    const current = (peer = new Peer({
      room, me: id, other, session, initiator: role === "host", stream,
      onMessage: (message) => {
        if (message.type === "sample") remoteSample = message; // host: the guest's accuracy
        if (message.type === "state") game.apply(message.state, seconds()); // guest: the host's game
      },
      onVideo: (video) => {
        remoteVideo.srcObject = video;
        remoteVideo.play().catch(() => {});
      },
      onOpen: () => (game.lobby.opponent = true),
      onClose: () => {
        if (peer !== current) return; // an older connection
        peer = null;
        game.lobby.opponent = false;
        game.reset(seconds());
      },
    }));
  };

  let remoteSample = null;
  let room = null;
  room = await openRoom(code, (message) => {
    if (!room || (message.to && message.to !== id)) return;
    if (role === "host") {
      if (message.type === "hello") {
        if (peer?.open && peer.other !== message.from) return room.send({ type: "full", to: message.from });
        const session = Math.random().toString(36).slice(2);
        room.send({ type: "welcome", from: id, to: message.from, session });
        connect(message.from, session);
      }
    } else if (message.type === "welcome") {
      connect(message.from, message.session);
    } else if (message.type === "full") {
      $("status").textContent = `Room ${code} is full.`;
      $("status").hidden = false;
    }
    if (message.type === "signal" && peer && message.from === peer.other && message.session === peer.session) peer.handleSignal(message);
    if (message.type === "bye" && peer && message.from === peer.other) peer.close();
  });
  addEventListener("pagehide", () => room.send({ type: "bye", from: id }));
  if (role === "guest") {
    const knock = () => peer || room.send({ type: "hello", from: id });
    knock();
    setInterval(knock, HELLO_SECONDS * 1000);
  }

  let startPressed = false;
  onPress(() => {
    sound.unlock();
    startPressed = true;
  });
  let lastSent = 0, lastSentState = null;
  runLoop((ctx, now) => {
    if (camera.update()) detector.update(camera.canvas, now);
    remote.update();
    // my accuracy, measured from the moment this device showed the meme
    const mine = game.state === "round" && camera.lastTime >= 0
      ? { raw: game.rawScore(detector.features(0, game.stateSince)), elapsed: now - game.stateSince, round: game.round }
      : null;
    if (role === "host") {
      const theirs = game.state === "round" && remoteSample?.round === game.round ? remoteSample : null;
      remoteSample = null;
      game.update(now, me === 0 ? [mine, theirs] : [theirs, mine], startPressed);
      if (now - lastSent >= 1 / STATE_RATE || game.state !== lastSentState) {
        peer?.send({ type: "state", state: game.snapshot(now) });
        lastSent = now;
        lastSentState = game.state;
      }
    } else if (mine) {
      peer?.send({ type: "sample", ...mine });
      game.accuracy[me] = mine.raw; // my own bar without the round trip to the host
    }
    startPressed = false;
    $("share").hidden = !(role === "host" && !game.lobby.opponent && game.state === "attract");
    game.render(ctx, now);
  });
}

showMenu();
