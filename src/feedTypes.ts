export type Source = "okx" | "polymarket"

export type Level = { price: number; size: number }
// bids sorted high→low, asks sorted low→high
export type Book = { bids: Level[]; asks: Level[] }

export type Quote = {
    kind: "quote"
    source: Source
    eventTitle?: string
    up: { bid: number; ask: number }
    down: { bid: number; ask: number }
    upBook?: Book
    downBook?: Book
    ts: number
}

export type EventSwitch = {
    kind: "event-switch"
    source: Source
    eventId: string
    endsAt?: number
}

export type FeedMessage = Quote | EventSwitch

const r4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * Build a full quote (top-of-book + depth) from the YES (Up) side book.
 * Down (NO) is the mirror: buying Down @ p == selling Up @ (1 - p).
 */
export function quoteFromYesBook(
    source: Source,
    yesBids: Level[],
    yesAsks: Level[],
    eventTitle?: string,
): Quote {
    const bids = [...yesBids]
        .filter((l) => Number.isFinite(l.price))
        .sort((a, b) => b.price - a.price)
    const asks = [...yesAsks]
        .filter((l) => Number.isFinite(l.price))
        .sort((a, b) => a.price - b.price)

    const upBid = bids[0]?.price ?? 0
    const upAsk = asks[0]?.price ?? 1

    const upBook: Book = {
        bids: bids.map((l) => ({ price: r4(l.price), size: l.size })),
        asks: asks.map((l) => ({ price: r4(l.price), size: l.size })),
    }
    const downBook: Book = {
        bids: asks.map((l) => ({ price: r4(1 - l.price), size: l.size })), // high→low
        asks: bids.map((l) => ({ price: r4(1 - l.price), size: l.size })), // low→high
    }

    return {
        kind: "quote",
        source,
        up: { bid: r4(upBid), ask: r4(upAsk) },
        down: { bid: r4(1 - upAsk), ask: r4(1 - upBid) },
        upBook,
        downBook,
        ts: Date.now(),
        ...(eventTitle !== undefined ? { eventTitle } : {}),
    }
}