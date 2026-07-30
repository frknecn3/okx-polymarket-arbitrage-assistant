"use client";
import { useEffect, useRef, useState } from "react";

// ── Types matching what your Express relay broadcasts ──────────────
export type BookLevel = { price: string; size: string };
export type OrderBook = { bids: BookLevel[]; asks: BookLevel[] };

// Snapshot seed: { kind: "book", tokenId, book }
// Stream update: { kind: "event", ev: <MarketBookEvent | MarketPriceChangeEvent | ...> }
type ServerMessage =
  | { kind: "book"; tokenId: string; book: OrderBook }
  | { kind: "event"; ev: any }; // tighten `any` once you log a real event

export function usePolymarketBook() {
  // Map of tokenId -> latest order book.
  const [books, setBooks] = useState<Record<string, OrderBook>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout;
    let stopped = false;

    function connect() {
      try {
        const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL as string);
        wsRef.current = ws;

        ws.onopen = () => setConnected(true);

        ws.onmessage = (e) => {
          if (e.data === "pong") return;

          let msg: ServerMessage;
          try {
            msg = JSON.parse(e.data as string);
          } catch {
            return; // ignore non-JSON frames
          }

          if (msg.kind === "book") {
            // Snapshot: replace the book for this token.
            setBooks((prev) => ({ ...prev, [msg.tokenId]: msg.book }));
          } else if (msg.kind === "event") {
            // Stream update: patch based on the event type.
            const ev = msg.ev;
            switch (ev.type) {
              case "MarketBookEvent":
                setBooks((prev) => ({
                  ...prev,
                  [ev.tokenId]: { bids: ev.bids, asks: ev.asks },
                }));
                break;
              case "MarketPriceChangeEvent":
              case "MarketLastTradePriceEvent":
                // apply incremental changes here once you confirm the shape
                break;
              default:
                break;
            }
          }
        };

        ws.onclose = () => {
          setConnected(false);
          if (!stopped) reconnectTimer = setTimeout(connect, 1000);
        };

        ws.onerror = () => ws.close(); // trigger onclose → reconnect
      } catch (err) {
        console.log(err);
        if (!stopped) reconnectTimer = setTimeout(connect, 1000);
      }
    }

    connect();

    // Cleanup on unmount — avoids leaked/double sockets (React strict mode).
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  return { books, connected };
}