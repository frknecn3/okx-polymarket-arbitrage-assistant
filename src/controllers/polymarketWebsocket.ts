// src/polymarket.ts
import { createPublicClient } from "@polymarket/client";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";

export async function startPolymarketFeed(wss: WebSocketServer, eventSlug: string) {
  const client = createPublicClient();

  const event = await client.fetchEvent({ slug: eventSlug });
  const tokenIds = event.markets.flatMap((m) => [
    m.outcomes.yes.tokenId!,
    m.outcomes.no.tokenId!,
  ]);

  const broadcast = (data: unknown) => {
    const payload = JSON.stringify(data);
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(payload);
    }
  };

  // seed
  for (const m of event.markets) {
    const yes = m.outcomes.yes.tokenId!;
    broadcast({ kind: "book", tokenId: yes, book: await client.fetchOrderBook({ tokenId: yes }) });
  }

  // stream, with auto-reconnect
  async function run() {
    const stream = await client.subscribe([{ topic: "market", tokenIds }]);
    try {
      for await (const ev of stream) broadcast({ kind: "event", ev });
    } catch (err) {
      console.error("Polymarket stream error:", err);
    } finally {
      console.log("stream ended, reconnecting in 2s");
      setTimeout(run, 2000);
    }
  }
  run();
}