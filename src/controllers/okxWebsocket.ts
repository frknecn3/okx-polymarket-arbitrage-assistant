export const createOkxWebsocket = async () => {
    const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");

    ws.onopen = () => {
        ws.send(JSON.stringify({
            op: "subscribe",
            args: [{ channel: "index-tickers", instId: "XAU-USD" }]
        }));
    };

    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (!msg.data) return;
        const t = msg.data[0];
        const last = parseFloat(t.idxPx);
        const open24h = parseFloat(t.open24h);
        const changePct = ((last - open24h) / open24h) * 100;

        console.log(
            `XAU/USD: ${last}  |  24h ${changePct >= 0 ? "▲ UP" : "▼ DOWN"} ${changePct.toFixed(2)}%`
        );
    };
}