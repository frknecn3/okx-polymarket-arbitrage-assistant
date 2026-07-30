// src/probeEvents.ts
const BASE = "https://www.okx.com"

async function get(path: string): Promise<any[]> {
	const res = await fetch(BASE + path)
	const json: any = await res.json()
	if (String(json.code) !== "0") {
		throw new Error(`code=${json.code} msg=${json.msg}`)
	}
	return json.data ?? []
}

// BTC-ABOVE-DAILY-260224-1600-65000 → BTC-ABOVE-DAILY
function seriesOf(instId: string): string {
	const parts = instId.split("-")
	const i = parts.findIndex((p) => /^\d{6}$/.test(p))
	return i > 0 ? parts.slice(0, i).join("-") : instId
}

async function main() {
	console.log("[probe] GET instruments?instType=EVENTS …")
	const insts = await get("/api/v5/public/instruments?instType=EVENTS")
	console.log(`[probe] total EVENTS instruments: ${insts.length}`)

	const series = new Map<string, number>()
	for (const it of insts) {
		const s = seriesOf(it.instId)
		series.set(s, (series.get(s) ?? 0) + 1)
	}
	console.log("\n[probe] distinct series:")
	for (const [s, n] of [...series.entries()].sort()) {
		console.log(`   ${s}  (${n})`)
	}

	const btc = insts.filter((it) => it.instId.startsWith("BTC"))
	console.log(`\n[probe] BTC instruments (${btc.length}):`)
	for (const it of btc.slice(0, 50)) {
		console.log(`   ${it.instId}  state=${it.state}`)
	}

	for (const s of [...new Set(btc.map((it) => seriesOf(it.instId)))]) {
		try {
			const evs = await get(
				`/api/v5/public/event-contract/events?seriesId=${s}&state=live`,
			)
			console.log(`\n[probe] LIVE events ${s}: ${evs.length}`)
			for (const e of evs.slice(0, 5)) {
				console.log(
					`   ${e.eventId}  exp=${new Date(Number(e.expTime)).toISOString()}`,
				)
			}
		} catch (err) {
			console.log(`\n[probe] events(${s}) error: ${(err as Error).message}`)
		}
	}
}

main().catch((e) => console.error("[probe] FATAL", e))