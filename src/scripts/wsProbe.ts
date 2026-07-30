import WebSocket from "ws"
import dotenv from "dotenv"

dotenv.config()

const OKX = process.env.OKX_BASE_URL ?? "https://www.okx.com"
const SERIES_ID = process.env.OKX_SERIES_ID ?? "BTC-UPDOWN-5MIN"

const ENDPOINTS = [
	"wss://ws.okx.com:8443/ws/v5/public",
	"wss://ws.okx.com:8443/ws/v5/business",
]

async function getJson(path: string): Promise<any | null> {
	const res = await fetch(OKX + path, { headers: { Accept: "application/json" } })
	const json = await res.json().catch(() => null)
	if (!json) {
		console.error(`[rest] ${path} → non-JSON (HTTP ${res.status})`)
		return null
	}
	if (String(json.code) !== "0") {
		console.error(`[rest] ${path} → code=${json.code} msg=${json.msg || "(none)"}`)
		return null
	}
	return json
}

/** Does depth exist at all? If REST is empty too, the problem is not the socket. */
async function restBooks(instId: string) {
	const j = await getJson(`/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=20`)
	const d = j?.data?.[0]
	console.log(
		`[rest] books ${instId} → bids=${d?.bids?.length ?? 0} asks=${d?.asks?.length ?? 0}`,
	)
	if (d?.asks?.[0]) console.log(`[rest]   best ask row: ${JSON.stringify(d.asks[0])}`)
	if (d?.bids?.[0]) console.log(`[rest]   best bid row: ${JSON.stringify(d.bids[0])}`)
}

/** Subscribe on one endpoint and dump every frame verbatim for `ms`. */
function probeWs(url: string, instId: string, ms = 12_000): Promise<void> {
	return new Promise((resolve) => {
		console.log(`\n===== ${url} =====`)
		const ws = new WebSocket(url)
		let frames = 0
		let books = 0
		let heartbeat: NodeJS.Timeout | undefined

		const done = () => {
			clearInterval(heartbeat)
			try {
				ws.close()
			} catch {}
			console.log(`[ws] ${url} → ${frames} frame(s), ${books} book frame(s)`)
			resolve()
		}

		ws.on("open", () => {
			console.log("[ws] open")
			ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "books", instId }] }))
			heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 20_000)
			setTimeout(done, ms)
		})

		ws.on("message", (raw) => {
			const text = raw.toString()
			if (text === "pong") return
			frames++

			let msg: any
			try {
				msg = JSON.parse(text)
			} catch {
				console.log(`[ws] non-JSON: ${text.slice(0, 120)}`)
				return
			}

			if (msg.event) {
				console.log(`[ws] event=${msg.event} code=${msg.code ?? "-"} msg=${msg.msg ?? "-"}`)
				return
			}

			if (msg.arg?.channel === "books") {
				books++
				const d = msg.data?.[0]
				// Only dump the first two in full — enough to see the row shape,
				// the seqId chain, and the exact checksum value.
				if (books <= 2) {
					console.log(
						`[ws] action=${msg.action} seqId=${d?.seqId} prevSeqId=${d?.prevSeqId} ` +
							`checksum=${d?.checksum} bids=${d?.bids?.length ?? 0} asks=${d?.asks?.length ?? 0}`,
					)
					console.log(`[ws]   asks[0..2]=${JSON.stringify((d?.asks ?? []).slice(0, 3))}`)
					console.log(`[ws]   bids[0..2]=${JSON.stringify((d?.bids ?? []).slice(0, 3))}`)
				}
			}
		})

		ws.on("error", (e) => console.error(`[ws] error: ${(e as Error).message}`))
		ws.on("close", (code) => {
			clearInterval(heartbeat)
			console.log(`[ws] closed ${code}`)
		})
	})
}

async function main() {
	const rows: any[] =
		(await getJson(`/api/v5/public/event-contract/markets?seriesId=${SERIES_ID}`))?.data ?? []

	const live = rows
		.filter((r) => r.state === "live")
		.map((r) => ({ instId: String(r.instId), endsAt: Number(r.expTime) }))
		.filter((r) => r.endsAt > Date.now())
		.sort((a, b) => a.endsAt - b.endsAt)

	console.log(`[rest] ${rows.length} market(s), ${live.length} live and unexpired`)
	for (const m of live.slice(0, 3)) {
		console.log(`[rest]   ${m.instId} ends ${new Date(m.endsAt).toISOString()}`)
	}

	const front = live[0]
	if (!front) {
		console.error("[rest] ✖ no live unexpired market — nothing to subscribe to.")
		return
	}

	console.log(`\n>>> probing front window: ${front.instId}\n`)
	await restBooks(front.instId)

	for (const url of ENDPOINTS) await probeWs(url, front.instId)
}

main().catch((e) => console.error(e))