import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { startPolymarketFeed } from "./controllers/polymarketWebsocket.js";
import { startOkxFeed } from "./controllers/okxWebsocket.js";
import type { FeedMessage } from "./types/feed.js";

const app = express();
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Remember the latest quote per source so new clients aren't blank.
const latest: Record<string, FeedMessage> = {};

wss.on("connection", (socket) => {
  console.log("🌐 browser connected. Total:", wss.clients.size);
  for (const msg of Object.values(latest)) socket.send(JSON.stringify(msg));
  socket.on("close", () => console.log("👋 browser left. Total:", wss.clients.size));
});

// One shared broadcast for BOTH feeds.
function broadcast(data: FeedMessage) {
  if (data.kind === "quote") latest[data.source] = data;
  const payload = JSON.stringify(data);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  }
}

// Keep browser sockets alive.
setInterval(() => {
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send("ping");
}, 20_000);

// ── Both feeds, same event, tagged by source ────────────────────────
const poly = startPolymarketFeed(wss, broadcast);
const okx = startOkxFeed(wss, broadcast);

server.listen(3001, () => console.log("🚀 http://localhost:3001"));

process.on("SIGINT", async () => {
  await Promise.allSettled([poly.stop(), okx.stop()]);
  process.exit(0);
});