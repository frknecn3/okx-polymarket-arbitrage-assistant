/* Shared quote model. Mirrored (minus builders) in ./clientFeed.ts */

export type Source = "okx" | "polymarket"
export type Asset = "BTC" | "ETH" | "SOL"

export const ASSETS: Asset[] = ["BTC", "ETH", "SOL"]

export type Level = { price: number; size: number }
export type Book = { bids: Level[]; asks: Level[] }

/** null means "no resting order on this side" — never fabricate 0 or 1. */
export type Side = { bid: number | null; ask: number | null }

/** px is the size-weighted price to fill `filled` contracts. */
export type EffLeg = { px: number | null; filled: number }
export type Eff = { upAsk: EffLeg; upBid: EffLeg; downAsk: EffLeg; downBid: EffLeg }

export type QuoteMeta = {
	asset: Asset
	slot: number
	eventId: string
	startsAt: number
	endsAt: number
}

export type Quote = {
	kind: "quote"
	source: Source
	asset: Asset
	ts: number
	slot: number
	eventId: string
	eventTitle: string
	startsAt: number
	endsAt: number
	up: Side
	down: Side
	upBook: Book
	downBook: Book
	eff: Eff
}

export type EventSwitch = {
	kind: "event-switch"
	source: Source
	asset: Asset
	eventId: string
	endsAt: number
}

export type FeedMessage = Quote | EventSwitch

/**
 * Identity of a quote. Source alone collides across assets, and
 * source+slot collides across assets — both must be in the key.
 */
export const quoteKey = (source: Source, asset: Asset, slot: number) =>
	`${source}:${asset}:${slot}`

export const MAX_LEVELS = 25
export const TARGET_SIZE = 100

export const r4 = (x: number) => Math.round(x * 10_000) / 10_000

export const clean = (ls: Level[]): Level[] =>
	(ls ?? [])
		.filter((l) => Number.isFinite(l?.price) && Number.isFinite(l?.size) && l.size > 0)
		.slice(0, MAX_LEVELS)

export const asBids = (ls: Level[]) => [...ls].sort((a, b) => b.price - a.price)
export const asAsks = (ls: Level[]) => [...ls].sort((a, b) => a.price - b.price)

export const bestOf = (b: Book): Side => ({
	bid: b.bids[0]?.price ?? null,
	ask: b.asks[0]?.price ?? null,
})

/**
 * Size-weighted cost to sweep `target` contracts. Returns how much actually
 * filled, so callers can tell a real 100-lot price from a 3-lot price that
 * merely looks attractive.
 */
export function vwap(levels: Level[], target = TARGET_SIZE): EffLeg {
	let need = target
	let cost = 0
	let filled = 0
	for (const l of levels) {
		if (need <= 0) break
		const take = Math.min(need, l.size)
		cost += take * l.price
		filled += take
		need -= take
	}
	return { px: filled > 0 ? r4(cost / filled) : null, filled: r4(filled) }
}

export const effOf = (up: Book, down: Book): Eff => ({
	upAsk: vwap(up.asks),
	upBid: vwap(up.bids),
	downAsk: vwap(down.asks),
	downBid: vwap(down.bids),
})

export function assemble(
	source: Source,
	up: Book,
	down: Book,
	eventTitle: string,
	meta: QuoteMeta,
): Quote {
	return {
		kind: "quote",
		source,
		asset: meta.asset,
		ts: Date.now(),
		slot: meta.slot,
		eventId: meta.eventId,
		eventTitle,
		startsAt: meta.startsAt,
		endsAt: meta.endsAt,
		up: bestOf(up),
		down: bestOf(down),
		upBook: up,
		downBook: down,
		eff: effOf(up, down),
	}
}

/**
 * One-sided venues (OKX EVENTS): only the UP/YES book exists.
 * A resting UP ask at p is economically a DOWN bid at 1 - p.
 */
export function quoteFromYesBook(
	source: Source,
	bids: Level[],
	asks: Level[],
	eventTitle: string,
	meta: QuoteMeta,
): Quote {
	const up: Book = { bids: asBids(clean(bids)), asks: asAsks(clean(asks)) }
	const flip = (ls: Level[]) => ls.map((l) => ({ price: r4(1 - l.price), size: l.size }))
	const down: Book = { bids: asBids(flip(up.asks)), asks: asAsks(flip(up.bids)) }
	return assemble(source, up, down, eventTitle, meta)
}

/** Two-sided venues (Polymarket): UP and DOWN are genuinely separate books. */
export function quoteFromBooks(
	source: Source,
	upRaw: Book,
	downRaw: Book,
	eventTitle: string,
	meta: QuoteMeta,
): Quote {
	const up: Book = { bids: asBids(clean(upRaw.bids)), asks: asAsks(clean(upRaw.asks)) }
	const down: Book = { bids: asBids(clean(downRaw.bids)), asks: asAsks(clean(downRaw.asks)) }
	return assemble(source, up, down, eventTitle, meta)
}