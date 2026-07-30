// src/probePoly.ts  →  npx tsx src/probePoly.ts
const GAMMA = "https://gamma-api.polymarket.com"
const CLOB = "https://clob.polymarket.com"
const FIVE = 300

async function j(url: string) {
	const r = await fetch(url, { headers: { Accept: "application/json" } })
	return { status: r.status, body: (await r.json().catch(() => null)) as any }
}

const slugFor = (epochSec: number) => `btc-updown-5m-${epochSec}`

async function main() {
	const nowSec = Math.floor(Date.now() / 1000)
	const base = Math.floor(nowSec / FIVE) * FIVE
	// scan previous → next few windows in case of an offset
	for (let k = -1; k <= 2; k++) {
		const slug = slugFor(base + k * FIVE)
		const { status, body } = await j(`${GAMMA}/events?slug=${slug}`)
		const ev = Array.isArray(body) ? body[0] : body
		const mkts = ev?.markets ?? []
		console.log(
			`\nslug=${slug} http=${status} events=${Array.isArray(body) ? body.length : body ? 1 : 0} markets=${mkts.length}` +
				(ev ? ` closed=${ev.closed} title="${ev.title}"` : ""),
		)
		for (const m of mkts) {
			console.log(`  Q: ${m.question} | enableOrderBook=${m.enableOrderBook} active=${m.active} closed=${m.closed}`)
			console.log(`  outcomes=${m.outcomes}`)
			console.log(`  clobTokenIds=${m.clobTokenIds}`)
			const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds || "[]") : m.clobTokenIds ?? []
			if (ids[0]) {
				const book = await j(`${CLOB}/book?token_id=${ids[0]}`)
				console.log(
					`  book(token0=${String(ids[0]).slice(0, 10)}…) http=${book.status} bids=${book.body?.bids?.length ?? 0} asks=${book.body?.asks?.length ?? 0}`,
				)
				console.log(`  book sample:`, JSON.stringify(book.body).slice(0, 300))
			}
		}
	}
}
main().catch((e) => console.error("FATAL", e))