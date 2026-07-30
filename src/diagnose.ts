import { createPublicClient } from "@polymarket/client";

// OKX uses region-specific domains — we'll test several to see which returns data.
const OKX_DOMAINS = [
  "https://www.okx.com",
  "https://my.okx.com",
  "https://app.okx.com",
  "https://eea.okx.com",
];

async function diagnoseOkx() {
  console.log("\n===== OKX DIAGNOSTIC =====");
  for (const base of OKX_DOMAINS) {
    for (const path of [
      `/api/v5/predictions/events/search?keyword=Bitcoin`,
      `/api/v5/predictions/events?limit=10`,
    ]) {
      try {
        const res = await fetch(base + path);
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        const events = json?.data?.events ?? (Array.isArray(json?.data) ? json.data : null);
        console.log(`\n[OKX] ${base}${path}`);
        console.log("  http:", res.status, "| code:", json?.code, "| msg:", json?.msg ?? json?.message);
        if (Array.isArray(events)) {
          console.log("  events count:", events.length);
          console.log(
            "  titles:",
            events.slice(0, 12).map((e: any) => `${e.status} | ${e.eventTitle ?? e.title}`)
          );
          if (events[0]) {
            console.log("  --- first event full object ---");
            console.dir(events[0], { depth: null });
          }
        } else {
          console.log("  raw body (first 400 chars):", text.slice(0, 400));
        }
      } catch (err) {
        console.log(`[OKX] ${base}${path} -> ERROR:`, (err as Error).message);
      }
    }
  }
}

async function diagnosePoly() {
  console.log("\n===== POLYMARKET DIAGNOSTIC =====");
  const client = createPublicClient();

  // 1) Which query finds the BTC 5-min market?
  for (const q of ["bitcoin up or down", "bitcoin", "btc", "bitcoin 5 minute", "crypto"]) {
    try {
      const results = client.search({ q, pageSize: 10 });
      const page = await results.firstPage();
      const events = page.items.events ?? [];
      console.log(`\n[POLY] search "${q}" -> ${events.length} events`);
      console.log("  titles/slugs:", events.slice(0, 10).map((e: any) => e.slug ?? e.title));
    } catch (err) {
      console.log(`[POLY] search "${q}" -> ERROR:`, (err as Error).message);
    }
  }

  // 2) Inspect the first event of the main query in full.
  try {
    const results = client.search({ q: "bitcoin up or down", pageSize: 5 });
    const page = await results.firstPage();
    const ev = (page.items.events ?? [])[0];
    if (!ev) { console.log("\n[POLY] no event to inspect"); return; }

    console.log("\n[POLY] --- first event full object ---");
    console.dir(ev, { depth: null });

    const market = ev.markets?.[0];
    const tokenId = market?.outcomes?.yes?.tokenId;
    console.log("[POLY] yes tokenId:", tokenId, "| market state:", market?.state);

    if (tokenId) {
      const book = await client.fetchOrderBook({ tokenId });
      console.log("[POLY] --- order book snapshot ---");
      console.dir(book, { depth: null });

      console.log("[POLY] --- first 3 stream events ---");
      const stream = await client.subscribe([{ topic: "market", tokenIds: [tokenId] }]);
      let n = 0;
      for await (const e of stream) {
        console.dir(e, { depth: null });
        if (++n >= 3) break;
      }
      await stream.close();
    }
  } catch (err) {
    console.log("[POLY] deep inspect ERROR:", (err as Error).message);
  }
}

async function main() {
  await diagnoseOkx();
  await diagnosePoly();
  process.exit(0);
}
main();