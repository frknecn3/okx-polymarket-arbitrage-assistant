/* Client mirror of the server's feed.ts. Types + pure helpers only. */

export type Source = "okx" | "polymarket"
export type Asset = "BTC" | "ETH" | "SOL"

export const ASSETS: Asset[] = ["BTC", "ETH", "SOL"]

export type Level = { price: number; size: number }
export type Book = { bids: Level[]; asks: Level[] }

/** null means "no resting order on this side" — never 0 or 1. */
export type Side = { bid: number | null; ask: number | null }

export type EffLeg = { px: number | null; filled: number }
export type Eff = { upAsk: EffLeg; upBid: EffLeg; downAsk: EffLeg; downBid: EffLeg }

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

export const TARGET_SIZE = 100

/** Source alone, and source+slot, both collide across assets. */
export const quoteKey = (source: Source, asset: Asset, slot: number) =>
	`${source}:${asset}:${slot}`