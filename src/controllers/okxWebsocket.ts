import type { WebSocketServer } from "ws"
import WebSocket from "ws"
import dotenv from "dotenv"
import {
	ASSETS,
	quoteFromYesBook,
	type Asset,
	type EventSwitch,
	type FeedMessage,
	type Level,
	type QuoteMeta,
} from "../types/feed.js"

dotenv.config()

/* ================================================================== *
 * Config
 * ================================================================== */

const OKX = process.env.OKX_BASE_URL ?? "https://www.okx.com"
const SLOTS = Number(process.env.OKX_SLOTS ?? 3)
const MARKET_REFRESH_MS = 2_000
const WINDOW_MS = 5 * 60 * 1000
const DEBUG = process.env.OKX_DEBUG !== "0"

const HEARTBEAT_MS = 20_000
const PONG_TIMEOUT_MS = 10_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const RESYNC_COOLDOWN_MS = 2_000
const TRANSPORT_PROBATION_MS = 15_000

/** BTC-UPDOWN-5MIN, ETH-UPDOWN-5MIN and SOL-UPDOWN-5MIN all exist. */
const seriesFor = (asset: Asset) => `${asset}-UPDOWN-5MIN`

/* ------------------------------------------------------------------ *
 * Transports, in priority order.
 *
 * 1. wspri/ipublic + books-grouped — what okx.com itself uses.
 *    UNDOCUMENTED AND UNVERSIONED; it can break without notice, which is
 *    exactly why 2 and 3 exist as automatic fallbacks.
 * 2. public + books-rpi — documented consolidated book (organic + RPI),
 *    400 levels, no checksum, rows [price, totalQty, nonRpiQty, count].
 * 3. public + books — documented and confirmed, but appears to carry only
 *    a subset of the depth okx.com displays.
 * ------------------------------------------------------------------ */

type Transport = {
	name: string
	url: string
	channel: string
	extra?: Record<string, string>
	browserHeaders?: boolean
	sizeIndex?: number
}

const TRANSPORTS: Transport[] = [
	{
		name: "ipublic/books-grouped",
		url: "wss://wspri.okx.com:8443/ws/v5/ipublic",
		channel: "books-grouped",
		extra: { grouping: "0.01" },
		browserHeaders: true,
	},
	{
		name: "public/books-rpi",
		url: "wss://ws.okx.com:8443/ws/v5/public",
		channel: "books-rpi",
	},
	{
		name: "public/books",
		url: "wss://ws.okx.com:8443/ws/v5/public",
		channel: "books",
	},
]

const PINNED = process.env.OKX_TRANSPORT ? Number(process.env.OKX_TRANSPORT) : null

const BROWSER_HEADERS = {
	Origin: "https://www.okx.com",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
		"Chrome/140.0.0.0 Safari/537.36",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "no-cache",
	Pragma: "no-cache",
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

const hhmm = (ms: number, tz = process.env.TZ ?? "Europe/Istanbul") =>
	new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone: tz,
	}).format(new Date(ms))

async function getJson(path: string): Promise<any | null> {
	try {
		const res = await fetch(OKX + path, { headers: { Accept: "application/json" } })
		const json = await res.json().catch(() => null)
		if (!json) {
			console.error(`[okx] ${path} → non-JSON response (HTTP ${res.status})`)
			return null
		}
		if (String(json.code) !== "0") {
			console.error(
				`[okx] ${path} → code=${json.code} msg=${json.msg || "(none)"} http=${res.status}`,
			)
			return null
		}
		return json
	} catch (e) {
		console.error(`[okx] ${path} → ${(e as Error).message}`)
		return null
	}
}

/* ================================================================== *
 * Book stream — one socket carrying every asset's instruments
 * ================================================================== */

type Entry = { price: number; size: number }
type BookState = { bids: Map<number, Entry>; asks: Map<number, Entry>; seqId: number }

export type OkxBookSnapshot = { bids: Level[]; asks: Level[] }
export type OkxBookHandler = (instId: string, book: OkxBookSnapshot) => void

export class OkxBookStream {
	private ws?: WebSocket | undefined
	private books = new Map<string, BookState>()
	private subscribed = new Set<string>()
	private lastResync = new Map<string, number>()
	private heartbeat?: NodeJS.Timeout | undefined
	private pongTimer?: NodeJS.Timeout | undefined
	private probation?: NodeJS.Timeout | undefined
	private backoff = BACKOFF_MIN_MS
	private closed = false

	private tIndex = PINNED ?? 0
	private frames = 0
	private loggedShape = false

	constructor(private onBook: OkxBookHandler) {}

	private get transport(): Transport {
		return TRANSPORTS[Math.min(this.tIndex, TRANSPORTS.length - 1)]!
	}

	connect(): void {
		if (this.closed) return
		const t = this.transport
		console.log(`[okx-ws] connecting via ${t.name} → ${t.url}`)

		const ws = new WebSocket(t.url, {
			perMessageDeflate: true,
			...(t.browserHeaders ? { headers: BROWSER_HEADERS, origin: "https://www.okx.com" } : {}),
		})
		this.ws = ws
		this.frames = 0

		ws.on("open", () => {
			console.log(`[okx-ws] open (${t.name})`)
			this.backoff = BACKOFF_MIN_MS
			this.startHeartbeat()
			if (this.subscribed.size) this.send("subscribe", [...this.subscribed])
			this.startProbation()
		})
		ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw.toString()))
		ws.on("close", (code: number, reason: Buffer) =>
			this.scheduleReconnect(`close ${code} ${reason.toString() || ""}`.trim()),
		)
		ws.on("error", (err: Error) =>
			console.error(`[okx-ws] socket error (${t.name}): ${err.message}`),
		)
	}

	close(): void {
		this.closed = true
		this.stopHeartbeat()
		this.stopProbation()
		this.books.clear()
		this.subscribed.clear()
		this.lastResync.clear()
		try {
			this.ws?.close()
		} catch {
			/* already gone */
		}
		this.ws = undefined
	}

	private demote(why: string): void {
		if (PINNED !== null) {
			console.error(`[okx-ws] ${this.transport.name} failing (${why}), OKX_TRANSPORT is pinned`)
			return
		}
		if (this.tIndex >= TRANSPORTS.length - 1) {
			console.error(`[okx-ws] ${this.transport.name} failing (${why}) — no transports left`)
			return
		}
		const from = this.transport.name
		this.tIndex++
		console.warn(`[okx-ws] ⚠ ${from} failing (${why}) → falling back to ${this.transport.name}`)
		this.books.clear()
		this.loggedShape = false
		try {
			this.ws?.terminate()
		} catch {
			/* ignore */
		}
	}

	private startProbation(): void {
		this.stopProbation()
		this.probation = setTimeout(() => {
			if (this.frames === 0 && this.subscribed.size > 0) {
				this.demote(`no book frames in ${TRANSPORT_PROBATION_MS}ms`)
			}
		}, TRANSPORT_PROBATION_MS)
	}

	private stopProbation(): void {
		if (this.probation) clearTimeout(this.probation)
		this.probation = undefined
	}

	private scheduleReconnect(why: string): void {
		if (this.closed) return
		this.stopHeartbeat()
		this.stopProbation()
		this.books.clear() // local books are valid only within one connection
		this.ws = undefined

		const delay = this.backoff
		this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
		console.warn(`[okx-ws] ${why} — reconnecting in ${delay}ms`)
		setTimeout(() => this.connect(), delay)
	}

	private startHeartbeat(): void {
		this.stopHeartbeat()
		this.heartbeat = setInterval(() => {
			if (this.ws?.readyState !== WebSocket.OPEN) return
			this.ws.send("ping")
			this.pongTimer = setTimeout(() => {
				console.warn("[okx-ws] pong timeout, terminating socket")
				this.ws?.terminate()
			}, PONG_TIMEOUT_MS)
		}, HEARTBEAT_MS)
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat)
		if (this.pongTimer) clearTimeout(this.pongTimer)
		this.heartbeat = undefined
		this.pongTimer = undefined
	}

	sync(instIds: string[]): void {
		const want = new Set(instIds)
		const add = instIds.filter((i) => !this.subscribed.has(i))
		const drop = [...this.subscribed].filter((i) => !want.has(i))

		for (const i of add) this.subscribed.add(i)
		for (const i of drop) {
			this.subscribed.delete(i)
			this.books.delete(i)
			this.lastResync.delete(i)
		}
		if (add.length) this.send("subscribe", add)
		if (drop.length) this.send("unsubscribe", drop)
	}

	private send(op: "subscribe" | "unsubscribe", instIds: string[]): void {
		if (this.ws?.readyState !== WebSocket.OPEN || !instIds.length) return
		const t = this.transport
		this.ws.send(
			JSON.stringify({
				op,
				args: instIds.map((instId) => ({ channel: t.channel, ...(t.extra ?? {}), instId })),
			}),
		)
		if (DEBUG) console.log(`[okx-ws] ${op} ${t.channel} × ${instIds.length}`)
	}

	private resync(instId: string, why: string): void {
		const now = Date.now()
		const last = this.lastResync.get(instId) ?? 0
		this.books.delete(instId)

		// An unthrottled resync-per-frame wipes the book, burns the subscribe
		// budget and emits nothing — a connection that looks healthy while
		// delivering an eternally empty ladder.
		if (now - last < RESYNC_COOLDOWN_MS) {
			if (DEBUG) console.warn(`[okx-ws] ${instId} ${why} (resync suppressed)`)
			return
		}
		this.lastResync.set(instId, now)
		console.warn(`[okx-ws] ${instId} ${why} — resyncing`)
		this.send("unsubscribe", [instId])
		this.send("subscribe", [instId])
	}

	private onMessage(text: string): void {
		if (text === "pong") {
			if (this.pongTimer) clearTimeout(this.pongTimer)
			this.pongTimer = undefined
			return
		}

		let msg: any
		try {
			msg = JSON.parse(text)
		} catch {
			console.error(`[okx-ws] non-JSON frame: ${text.slice(0, 200)}`)
			return
		}

		if (msg.event === "error") {
			console.error(`[okx-ws] code=${msg.code} msg=${msg.msg || "(none)"}`)
			if (String(msg.code) === "60018") this.demote(`rejected: ${msg.msg}`)
			return
		}
		if (msg.event) return

		if (msg.arg?.channel === this.transport.channel) this.applyBooks(msg)
	}

	private applyBooks(msg: any): void {
		const instId: string | undefined = msg.arg?.instId
		const d = msg.data?.[0]
		if (!instId || !d) return

		this.frames++

		// The internal channel's payload layout is unverified. Dump the first
		// frame so a surprise shape is visible instead of parsing to nothing.
		if (!this.loggedShape) {
			this.loggedShape = true
			console.log(
				`[okx-ws] first ${this.transport.channel} frame (action=${msg.action ?? "-"}):\n` +
					JSON.stringify(d).slice(0, 800),
			)
		}

		// books: [price, size, deprecatedZero, count]
		// books-rpi: [price, totalQty, nonRpiQty, count] — index 1 is the
		// total in both cases, so one accessor serves both.
		const sizeIdx = this.transport.sizeIndex ?? 1
		const toEntry = (r: any): Entry | null => {
			const price = Number(r?.[0])
			const size = Number(r?.[sizeIdx])
			if (!Number.isFinite(price) || !Number.isFinite(size)) return null
			return { price, size }
		}

		// Integer thousandths: tail bands tick at 0.001, and float keys would
		// split a single price level across multiple map entries.
		const key = (price: number) => Math.round(price * 1000)

		const load = (rows: any[]): Map<number, Entry> => {
			const m = new Map<number, Entry>()
			for (const r of rows ?? []) {
				const e = toEntry(r)
				if (e && e.size > 0) m.set(key(e.price), e)
			}
			return m
		}

		// Anything not explicitly "update" is treated as a full snapshot.
		// Grouped books are often pushed whole, and guessing "incremental" on
		// a snapshot stream corrupts the book permanently.
		const isUpdate = msg.action === "update" && this.books.has(instId)

		if (!isUpdate) {
			this.books.set(instId, { bids: load(d.bids), asks: load(d.asks), seqId: Number(d.seqId) })
		} else {
			const st = this.books.get(instId)!
			const prev = Number(d.prevSeqId)
			// Snapshots carry prevSeqId -1; that sentinel is not a gap.
			if (Number.isFinite(prev) && prev >= 0 && Number.isFinite(st.seqId) && prev !== st.seqId) {
				this.resync(instId, `seq gap: have ${st.seqId}, frame claims prev ${prev}`)
				return
			}
			const apply = (side: Map<number, Entry>, rows: any[]) => {
				for (const r of rows ?? []) {
					const e = toEntry(r)
					if (!e) continue
					if (e.size === 0) side.delete(key(e.price)) // size 0 = level removed
					else side.set(key(e.price), e)
				}
			}
			apply(st.bids, d.bids)
			apply(st.asks, d.asks)
			st.seqId = Number(d.seqId)
		}

		const st = this.books.get(instId)
		if (!st) return

		this.onBook(instId, {
			bids: [...st.bids.values()].sort((a, b) => b.price - a.price),
			asks: [...st.asks.values()].sort((a, b) => a.price - b.price),
		})
	}
}

/* ================================================================== *
 * Market discovery (per series)
 *
 *   expTime   window END, epoch ms
 *   listTime  ~35 min before expiry — NOT the window start
 *   state     "live" means tradable, so several windows are live at once
 * ================================================================== */

type EventMarket = { instId: string; startsAt: number; endsAt: number }

const marketCache = new Map<string, { ts: number; list: EventMarket[] }>()
const dumped = new Set<string>()

async function discoverMarkets(seriesId: string): Promise<EventMarket[]> {
	const now = Date.now()
	const cached = marketCache.get(seriesId)
	const stale = !cached || now - cached.ts >= MARKET_REFRESH_MS
	const rolled = !!cached?.list.length && now > (cached.list[0]?.endsAt ?? 0)
	if (cached?.list.length && !stale && !rolled) return cached.list

	const rows: any[] =
		(
			await getJson(
				`/api/v5/public/event-contract/markets?seriesId=${encodeURIComponent(seriesId)}`,
			)
		)?.data ?? []

	if (!rows.length) {
		console.error(`[okx] ✖ no markets for seriesId=${seriesId} on ${OKX}`)
		return cached?.list ?? []
	}

	if (!dumped.has(seriesId)) {
		dumped.add(seriesId)
		if (DEBUG) console.log(`[okx] ${seriesId} sample:\n${JSON.stringify(rows[0], null, 2)}`)
	}

	const list: EventMarket[] = rows
		.filter((r: any) => r.state === "live")
		.map((r: any) => {
			const endsAt = Number(r.expTime)
			return { instId: String(r.instId), startsAt: endsAt - WINDOW_MS, endsAt }
		})
		.filter((r: EventMarket) => Number.isFinite(r.endsAt) && r.endsAt > now)
		.sort((a: EventMarket, b: EventMarket) => a.endsAt - b.endsAt)

	marketCache.set(seriesId, { ts: now, list })
	return list
}

/* ================================================================== *
 * Feed
 * ================================================================== */

type Placed = { asset: Asset; slot: number; market: EventMarket }

export class OkxManager {
	private stream: OkxBookStream
	private index = new Map<string, Placed>() // instId → where it belongs
	private live = new Map<Asset, string>()
	private timer?: NodeJS.Timeout | undefined

	constructor(
		private broadcast: (m: FeedMessage) => void,
		private assets: Asset[] = ASSETS,
	) {
		this.stream = new OkxBookStream((instId, book) => this.emit(instId, book))
	}

	async start(): Promise<void> {
		console.log(`[okx] ✅ feed booting. host=${OKX} assets=${this.assets.join(",")}`)
		this.stream.connect()
		await this.refresh()
		this.timer = setInterval(
			() => this.refresh().catch((e) => console.error("[okx] refresh err", e)),
			MARKET_REFRESH_MS,
		)
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		this.stream.close()
	}

	private async refresh(): Promise<void> {
		const perAsset = await Promise.all(
			this.assets.map(async (asset) => ({
				asset,
				markets: (await discoverMarkets(seriesFor(asset))).slice(0, SLOTS),
			})),
		)

		const next = new Map<string, Placed>()
		for (const { asset, markets } of perAsset) {
			markets.forEach((market, slot) => next.set(market.instId, { asset, slot, market }))

			const front = markets[0]
			if (front && this.live.get(asset) !== front.instId) {
				this.live.set(asset, front.instId)
				console.log(
					`[okx] ▶ ${asset} front ${front.instId} (ends ${new Date(front.endsAt).toISOString()})`,
				)
				const sw: EventSwitch = {
					kind: "event-switch",
					source: "okx",
					asset,
					eventId: front.instId,
					endsAt: front.endsAt,
				}
				this.broadcast(sw)
			}
		}

		this.index = next
		this.stream.sync([...next.keys()])
	}

	/** OKX EVENTS exposes the UP/YES side only; feed.ts mirrors DOWN at 1 - p. */
	private emit(instId: string, book: OkxBookSnapshot): void {
		const placed = this.index.get(instId)
		if (!placed) return // a book for a window we already rolled past

		const { asset, slot, market } = placed
		const meta: QuoteMeta = {
			asset,
			slot,
			eventId: market.instId,
			startsAt: market.startsAt,
			endsAt: market.endsAt,
		}
		const title = `${asset} 5m ${hhmm(market.startsAt)}-${hhmm(market.endsAt)}`

		this.broadcast(quoteFromYesBook("okx", book.bids, book.asks, title, meta))

		if (DEBUG && slot === 0) {
			const a = book.asks[0]
			const b = book.bids[0]
			console.log(
				`[okx] ${asset} ${market.instId} UP ask=${a?.price ?? "-"}(${a?.size ?? "-"}) ` +
					`bid=${b?.price ?? "-"}(${b?.size ?? "-"}) depth=${book.asks.length}/${book.bids.length}`,
			)
		}
	}
}

export function startOkxFeed(
	_wss: WebSocketServer,
	broadcast: (m: FeedMessage) => void,
): OkxManager {
	const mgr = new OkxManager(broadcast)
	mgr.start().catch((e) => console.error("[okx] start failed", e))
	return mgr
}