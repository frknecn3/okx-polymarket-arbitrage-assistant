// tsx src/probeOkxBook.ts
const OKX = "https://www.okx.com"
const SERIES = "BTC-UPDOWN-5MIN"
const WINDOW_MS = 5 * 60 * 1000
const CN = 8 * 60 * 60 * 1000
const pad = (n: number) => String(n).padStart(2, "0")
const wall = (ms: number) => {
  const d = new Date(ms + CN)
  return {
    ymd: String(d.getUTCFullYear()).slice(2) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()),
    hm: pad(d.getUTCHours()) + pad(d.getUTCMinutes()),
  }
}
const now = Date.now()
const start = Math.floor(now / WINDOW_MS) * WINDOW_MS
const s = wall(start), e = wall(start + WINDOW_MS)
const instId = `${SERIES}-${s.ymd}-${s.hm}-${e.hm}`
console.log("LIVE instId =", instId, "\n")

// UI panelinde şu an gördüğün en iyi ask/bid'i buraya yaz (eşleştirme için):
const UI_BEST_ASK = 0.42
const UI_BEST_BID = 0.41

const candidates = [
  `/api/v5/market/books?instId=${instId}&sz=20`,
  `/priapi/v5/public/products?instType=EVENTS&instId=${instId}&includeType=2`,
  `/priapi/v5/public/products?instType=EVENTS&instId=${instId}&includeType=1`,
  `/priapi/v5/public/products?instType=EVENTS&instId=${instId}`,
  `/priapi/v5/rubik/event-contract/market/books?instId=${instId}&sz=20`,
  `/priapi/v5/rubik/event-contract/market/depth?instId=${instId}`,
  `/priapi/v5/rubik/event-contract/market/inst-list?seriesId=${SERIES}&method=PRICE_UP_DOWN`,
  `/api/v5/public/event-markets?instId=${instId}`,
  `/api/v5/market/event-contract/books?instId=${instId}&sz=20`,
]

const H = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
}

// bir objenin içindeki [price,size] benzeri ilk dizileri kabaca yakala
function scan(o: any, depth = 0): string[] {
  const out: string[] = []
  if (!o || depth > 4) return out
  if (Array.isArray(o)) {
    const nums = o.filter(Array.isArray).slice(0, 3)
    if (nums.length) out.push(JSON.stringify(nums))
    for (const v of o.slice(0, 3)) out.push(...scan(v, depth + 1))
  } else if (typeof o === "object") {
    for (const k of Object.keys(o)) {
      if (/ask|bid|book|depth|px|order/i.test(k)) out.push(`${k}: ${JSON.stringify(o[k]).slice(0, 160)}`)
      out.push(...scan(o[k], depth + 1))
    }
  }
  return out
}

for (const path of candidates) {
  try {
    const res = await fetch(OKX + path, { headers: H })
    const txt = await res.text()
    let json: any = null
    try { json = JSON.parse(txt) } catch {}
    console.log("──".repeat(30))
    console.log("GET", path)
    console.log("  status:", res.status, "code:", json?.code, "msg:", json?.msg)
    if (json) {
      const hits = [...new Set(scan(json))].slice(0, 8)
      if (hits.length) console.log("  hits:\n   " + hits.join("\n   "))
      else console.log("  body:", txt.slice(0, 200))
    } else {
      console.log("  raw:", txt.slice(0, 200))
    }
  } catch (err) {
    console.log("GET", path, "→ ERR", (err as Error).message)
  }
}
console.log("\nUI ref → ask", UI_BEST_ASK, "bid", UI_BEST_BID, "(bununla eşleşen candidate'ı arıyoruz)")

const tests = [
  `/api/v5/market/books-full?instId=${instId}&sz=400`,   // OKX tam derinlik ucu
  `/api/v5/market/books?instId=${instId}&sz=400`,          // tüm seviyeleri dök
]
for (const p of tests) {
  const r = await fetch(OKX + p, { headers: H })
  const j = await r.json()
  console.log("\n== GET", p, "status", r.status, "code", j.code)
  const b = j.data?.[0]
  if (b) {
    console.log("asks:", (b.asks ?? []).slice(0, 12))
    console.log("bids:", (b.bids ?? []).slice(0, 12))
  } else {
    console.log(JSON.stringify(j).slice(0, 300))
  }
}