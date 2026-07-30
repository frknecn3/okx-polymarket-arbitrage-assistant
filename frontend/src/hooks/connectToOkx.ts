"use client";

import { useEffect, useState } from "react";

export function useGoldPrice() {
    const [data, setData] = useState<Record<string,any> | null>(null);
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        let ws: WebSocket;
        let reconnectTimer: NodeJS.Timeout;
        let stopped = false;

        function connect() {
            try {
                ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL as string);

                ws.onopen = () => setConnected(true);
                ws.onmessage = (e) => {

                    if (e.data == "pong") return;

                    setData(JSON.parse(e.data as string))
                };
                ws.onclose = () => {
                    setConnected(false);
                    if (!stopped) reconnectTimer = setTimeout(connect, 1000);
                };
            }
            catch (err) {
                console.log(err)
            }
        }

        connect();

        // Cleanup on unmount — critical in React to avoid leaked/double sockets.
        return () => {
            stopped = true;
            clearTimeout(reconnectTimer);
            ws?.close();
        };
    }, []);

    return { data, connected };
}