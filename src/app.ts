import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();

// ! don't need it cuz we're using nextjs now
// // Serve the frontend (anything in /public) over normal REST/HTTP.
// app.use(express.static("public"));

// A plain REST route still works exactly like you're used to:
app.get("/health", (req, res) => res.send("ok"));

// ── ONE http server shared by Express + WebSockets ──────────────────
const server = http.createServer(app);

// Our WebSocket server for BROWSERS to connect to.
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
    console.log("🌐 A browser connected. Total:", wss.clients.size);

    // If we already have a latest price, send it immediately so the new
    // client isn't staring at "connecting…" until the next tick.
    if (latest) socket.send(JSON.stringify(latest));

    socket.on("close", () =>
        console.log("👋 A browser left. Total:", wss.clients.size)
    );
});

// Push a message to EVERY connected browser.
function broadcast(data: any) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
}

// ── Our OUTGOING connection to OKX (server acts as a client here) ───
let latest: { price: number; changePct: number; ts: number; } | null = null; // remember the last price we saw

function connectToOkx() {
    const okx = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");

    okx.on("open", () => {
        console.log("✅ Connected to OKX");
        // Subscribe to the XAU/USD index ticker.
        okx.send(
            JSON.stringify({
                op: "subscribe",
                args: [{ channel: "index-tickers", instId: "XAU-USD" }],
            })
        );
    });

    okx.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (!msg.data) return; // ignore subscribe confirmations, etc.

        const t = msg.data[0];
        const price = parseFloat(t.idxPx);
        const open24h = parseFloat(t.open24h);
        const changePct = ((price - open24h) / open24h) * 100;

        latest = { price, changePct, ts: Date.now() };
        broadcast(latest); // fan out to all browsers
    });

    // Keep the OKX connection alive (their proxy drops idle sockets).
    const ping = setInterval(() => {
        if (okx.readyState === WebSocket.OPEN) okx.send("ping");
    }, 20000);

    // If OKX drops us, clean up and reconnect after a short delay.
    okx.on("close", () => {
        clearInterval(ping);
        console.log("⚠️  OKX disconnected. Reconnecting in 2s…");
        setTimeout(connectToOkx, 2000);
    });

    okx.on("error", (err: unknown) => {
        if (err instanceof Error) console.error("OKX error:", err.message);
        okx.close(); // triggers the reconnect above
    });
}

connectToOkx();

server.listen(3000, () =>
    console.log("🚀 http://localhost:3000")
);