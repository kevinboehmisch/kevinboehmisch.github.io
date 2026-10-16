// Online games: a free Supabase project brings the two players together (supabase.com → New project,
// then Project Settings → API: "Project URL" and the "anon public" key). Only Realtime is used, no
// tables. The anon key is meant to be public; it ends up in every visitor's browser anyway.
export const SUPABASE_URL = "https://txvfurrwpxvytkuwpeje.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dmZ1cnJ3cHh2eXRrdXdwZWplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTk2MzMsImV4cCI6MjEwNzczNTYzM30.vTzNCEWxLB0xWBUT6wFBdLTFd8OktOTXkVXgWiPBvaA";

// WebRTC: STUN lets the two devices find each other's public address. Behind strict networks (some
// mobile networks, company Wi-Fi) a direct connection is impossible and a TURN relay is needed too,
// e.g. { urls: "turn:...", username: "...", credential: "..." } from a TURN provider.
// Every server added here receives the players' IP addresses: name it in the privacy policy.
export const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
