import type { WebSocketServer } from "ws"
import {
	ASSETS,
	quoteFromBooks,
	type Asset,
	type Book,
	type FeedMessage,
	type Level,
	type QuoteMeta,
} from "../types/feed.js"

const GAMMA = "https://gamma-api.polymarket.com"
const CLOB = "https://clob.polymarket.com"

const WINDOW_SEC = 300
const WINDOW_MS = WINDOW_SEC * 1000
const SLOTS = 3 // 0 = live, 1 = +5m, 2 = +10m — must match OKX
const POLL_MS = 1500
const DEBUG = process.env.POLY_DEBUG !== "0"

/** Confirmed live slug pattern: btc-/eth-/sol-updown-5m-{windowStartEpochSec} */
const SLUG_PREFIX: Record<Asset, string> = {
	BTC: "btc-updown-5m",
	ETH: "eth-updown-5m",
	SOL: "sol-updown-5m",
}
const slugFor = (asset: Asset, epochSec: number) => `${SLUG_PREFIX[asset]}-${epochSec}`

/**
 * Token fields spell out `| undefined` because tsconfig sets
 * exactOptionalPropertyTypes, under which `?:` permits absence but not an
 * explicit undefined assignment.
 */
type MarketInfo = {
	title: string
	closed: boolean
	enableOrderBook: boolean
	upToken?: string | undefined
	downToken?: string | undefined
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
	const r = await fetch(url, { headers: { Accept: "application/json" } })
	return { status: r.status, body: await r.json().catch(() => null) }
}

async function fetchMarket(slug: string): Promise<MarketInfo | null> {
	const { status, body } = await getJson(`${GAMMA}/events?slug=${slug}`)
	const ev = Array.isArray(body) ? body[0] : body
	const m = ev?.markets?.[0]
	if (status !== 200 || !m) return null

	const ids =
		typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds || "[]") : (m.clobTokenIds ?? [])

	return {
		title: String(ev.title ?? slug),
		closed: Boolean(m.closed),
		enableOrderBook: Boolean(m.enableOrderBook),
		upToken: ids[0] as string | undefined, // outcomes[0] = "Up"
		downToken: ids[1] as string | undefined, // outcomes[1] = "Down"
	}
}

async function fetchBook(tokenId: string): Promise<Book | null> {
	const { status, body } = await getJson(`${CLOB}/book?token_id=${tokenId}`)
	if (status !== 200 || !body || body.error) return null
	const lv = (arr: any[]): Level[] =>
		(arr ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }))
	return { bids: lv(body.bids), asks: lv(body.asks) }
}

/** Fallback only: buy X @ p ≡ sell ~X @ (1 - p). */
const mirror = (b: Book): Book => ({
	bids: b.asks.map((l) => ({ price: 1 - l.price, size: l.size })),
	asks: b.bids.map((l) => ({ price: 1 - l.price, size: l.size })),
})

/**
 * Token IDs are immutable per window, so Gamma is queried once per slug
 * instead of once per poll. Without this, 3 assets × 3 slots every 1.5 s
 * would mean thousands of redundant lookups per hour.
 */
type CacheEntry = { info: MarketInfo | null; ts: number }
const marketCache = new Map<string, CacheEntry>()
const MISS_RETRY_MS = 15_000

async function marketFor(slug: string): Promise<MarketInfo | null> {
	const hit = marketCache.get(slug)
	// A found market is cached for the life of the window; a miss is retried,
	// since future windows are often created shortly before they open.
	if (hit && (hit.info !== null || Date.now() - hit.ts < MISS_RETRY_MS)) return hit.info

	const info = await fetchMarket(slug)
	marketCache.set(slug, { info, ts: Date.now() })
	return info
}

function pruneCache(oldestEpochSec: number): void {
	for (const slug of marketCache.keys()) {
		const epoch = Number(slug.slice(slug.lastIndexOf("-") + 1))
		if (Number.isFinite(epoch) && epoch < oldestEpochSec) marketCache.delete(slug)
	}
}

class PolymarketManager {
	private timer?: NodeJS.Timeout | undefined
	private live = new Map<Asset, string>()
	private loggedShape = false

	constructor(
		private broadcast: (m: FeedMessage) => void,
		private assets: Asset[] = ASSETS,
	) {}

	async start(): Promise<void> {
		console.log(`[poly] ✅ 5m feed booted. assets=${this.assets.join(",")} gamma=${GAMMA}`)
		await this.poll()
		this.timer = setInterval(
			() => this.poll().catch((e) => console.error("[poly] poll err", e)),
			POLL_MS,
		)
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	private async poll(): Promise<void> {
		const baseSec = Math.floor(Date.now() / 1000 / WINDOW_SEC) * WINDOW_SEC
		pruneCache(baseSec - WINDOW_SEC)

		// All asset × slot pairs run concurrently. Sequential awaits across
		// nine markets cannot finish inside a 1500 ms tick.
		const jobs: Array<Promise<void>> = []
		for (const asset of this.assets) {
			for (let slot = 0; slot < SLOTS; slot++) {
				jobs.push(this.one(asset, slot, baseSec + slot * WINDOW_SEC))
			}
		}
		await Promise.allSettled(jobs)
	}

	private async one(asset: Asset, slot: number, epochSec: number): Promise<void> {
		const slug = slugFor(asset, epochSec)
		const startMs = epochSec * 1000
		const endMs = startMs + WINDOW_MS

		try {
			const mkt = await marketFor(slug)
			// Not every asset lists every window. A missing counterpart is
			// normal, not an error — the UI renders that venue as absent.
			if (!mkt || mkt.closed || !mkt.enableOrderBook || !mkt.upToken || !mkt.downToken) return

			const [upRaw, downRaw] = await Promise.all([
				fetchBook(mkt.upToken),
				fetchBook(mkt.downToken),
			])
			if (!upRaw && !downRaw) return

			const up = upRaw ?? mirror(downRaw!)
			const down = downRaw ?? mirror(upRaw!)

			const meta: QuoteMeta = { asset, slot, eventId: slug, startsAt: startMs, endsAt: endMs }
			this.broadcast(quoteFromBooks("polymarket", up, down, mkt.title, meta))

			if (slot === 0) {
				if (this.live.get(asset) !== slug) {
					this.live.set(asset, slug)
					console.log(`[poly] ▶ ${asset} live ${slug} "${mkt.title}"`)
					this.broadcast({
						kind: "event-switch",
						source: "polymarket",
						asset,
						eventId: slug,
						endsAt: endMs,
					})
				}
				if (DEBUG) {
					console.log(
						`[poly] ${asset} slot0 up=${up.bids.length}/${up.asks.length} ` +
							`down=${down.bids.length}/${down.asks.length}` +
							(this.loggedShape
								? ""
								: ` upBid0=${up.bids[0]?.price} downAsk0=${down.asks[0]?.price}`),
					)
					this.loggedShape = true
				}
			}
		} catch (e) {
			console.error(`[poly] ${asset} slot ${slot} err`, (e as Error).message)
		}
	}
}

export function startPolymarketFeed(
	_wss: WebSocketServer,
	broadcast: (m: FeedMessage) => void,
): PolymarketManager {
	const mgr = new PolymarketManager(broadcast)
	mgr.start().catch((e) => console.error("[poly] start failed", e))
	return mgr
}