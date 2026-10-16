// Online games: a room brings two devices together, then they talk directly over WebRTC
// (camera video plus a data channel for the game). The room only carries the few messages
// needed until then:
//   hello {from}            guest → host: I want to play
//   welcome {from, to, session}      host → guest: you are player 2, a connection offer follows
//   full {to}                        host → guest: someone else is already playing
//   signal {from, to, session, ...}  WebRTC offer, answer and network addresses, both ways
//   bye {from}              the page is being closed
//
// Rooms run over Supabase Realtime (config.js). For trying it out on one computer, ?transport=tabs
// uses the browser's BroadcastChannel instead: two tabs of the same browser, no internet needed.

import { ICE_SERVERS, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

const params = new URLSearchParams(location.search);
export const TRANSPORT = params.get("transport") === "tabs" ? "tabs" : "supabase";
const SUPABASE_JS = ["vendor/supabase.js", "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"]; // version as in build.py

export const onlineAvailable = () => TRANSPORT === "tabs" || Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export function newRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: easy to read out
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
}

function loadScript(urls) {
  const [url, ...rest] = urls;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => (rest.length ? loadScript(rest).then(resolve, reject) : reject(new Error(`Cannot load ${url}`)));
    document.head.append(script);
  });
}

class TabsRoom {
  constructor(code, onMessage) {
    this.channel = new BroadcastChannel(`meme-karaoke-${code}`);
    this.channel.onmessage = (event) => onMessage(event.data);
  }

  send(message) {
    this.channel.postMessage(message);
  }
}

class SupabaseRoom {
  static async open(code, onMessage) {
    if (!window.supabase) await loadScript(SUPABASE_JS);
    // no login: nothing is stored in or read from the browser's storage
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = client.channel(`meme-karaoke-${code}`, { config: { broadcast: { self: false } } });
    channel.on("broadcast", { event: "message" }, ({ payload }) => onMessage(payload));
    await new Promise((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") resolve();
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`Supabase: ${error?.message ?? status}`));
      });
    });
    return new SupabaseRoom(channel);
  }

  constructor(channel) {
    this.channel = channel;
  }

  send(message) {
    this.channel.send({ type: "broadcast", event: "message", payload: message });
  }
}

export async function openRoom(code, onMessage) {
  return TRANSPORT === "tabs" ? new TabsRoom(code, onMessage) : SupabaseRoom.open(code, onMessage);
}

/** The direct connection to the other player: their camera video and a data channel for the game. */
export class Peer {
  /** initiator: the host, who makes the offer. session: tells signals of this connection from those of an older one. */
  constructor({ room, me, other, session, initiator, stream, onMessage, onVideo, onOpen, onClose }) {
    Object.assign(this, { room, me, other, session, stream, onMessage, onOpen, onClose });
    this.channel = null;
    this.closed = false;
    this.pendingCandidates = []; // network addresses that arrive before the offer/answer
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.ontrack = (event) => onVideo(event.streams[0] ?? new MediaStream([event.track]));
    this.pc.onicecandidate = (event) => event.candidate && this.signal({ candidate: event.candidate.toJSON() });
    this.pc.onconnectionstatechange = () => {
      console.log(`WebRTC: ${this.pc.connectionState}`);
      if (this.pc.connectionState === "failed") this.close();
    };
    if (initiator) {
      this.addTracks();
      this.useChannel(this.pc.createDataChannel("game"));
      this.makeOffer();
    } else {
      this.pc.ondatachannel = (event) => this.useChannel(event.channel);
    }
  }

  addTracks() {
    for (const track of this.stream.getVideoTracks()) this.pc.addTrack(track, this.stream);
  }

  async makeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ description: this.pc.localDescription.toJSON() });
  }

  useChannel(channel) {
    this.channel = channel;
    channel.onmessage = (event) => this.onMessage(JSON.parse(event.data));
    channel.onclose = () => this.close();
    channel.onopen = () => this.onOpen();
    if (channel.readyState === "open") this.onOpen();
  }

  signal(data) {
    this.room.send({ type: "signal", from: this.me, to: this.other, session: this.session, ...data });
  }

  async handleSignal({ description, candidate }) {
    if (description) {
      await this.pc.setRemoteDescription(description);
      if (description.type === "offer") {
        this.addTracks(); // after the offer, so the camera goes out on the video line the host offered
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal({ description: this.pc.localDescription.toJSON() });
      }
      for (const pending of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(pending).catch(() => {});
    } else if (candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => {});
      else this.pendingCandidates.push(candidate);
    }
  }

  get open() {
    return this.channel?.readyState === "open";
  }

  send(message) {
    if (this.open) this.channel.send(JSON.stringify(message));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.pc.close();
    this.onClose();
  }
}
