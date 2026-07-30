import type { Book, Level } from "../types/feed.js"

/* ------------------------------------------------------------------ *
 * Price arithmetic
 *
 * Tick bands for the UPDOWN series (from /api/v5/public/instrument-tick-bands):
 *   0.000 – 0.040  →  tickSz 0.001
 *   0.040 – 0.960  →  tickSz 0.01
 *   0.960 – 1.000  →  tickSz 0.001
 *
 * Integer thousandths represent every band exactly and make the YES/NO
 * mirror lossless. Rounding to 2dp silently destroys the tail bands, which
 * is precisely where a 5-minute contract spends its final seconds.
 * ------------------------------------------------------------------ */

export const MILLS = 1000

export const toMills = (raw: unknown): number => Math.round(Number(raw) * MILLS)
export const fromMills = (t: number): number => t / MILLS

/** OKX book rows are [price, size, deprecatedAlwaysZero, orderCount]. */
export const rowsToLevels = (rows: unknown): Level[] =>
	(Array.isArray(rows) ? rows : [])
		.map((r: any) => ({ mills: toMills(r?.[0]), size: Number(r?.[1]) }))
		.filter((l) => Number.isFinite(l.mills) && Number.isFinite(l.size) && l.size > 0)
		.map((l) => ({ price: fromMills(l.mills), size: l.size }))

/**
 * UP and DOWN share one book, reflected about 1.
 *   a resting UP ask @ p  ==  a DOWN bid @ (1 - p)
 *   a resting UP bid @ p  ==  a DOWN ask @ (1 - p)
 * Size carries over unchanged.
 */
const mirror = (ls: Level[]): Level[] =>
	ls.map((l) => ({ price: fromMills(MILLS - toMills(l.price)), size: l.size }))

export const downFromUp = (up: Book): Book => ({
	bids: mirror(up.asks).sort((a, b) => b.price - a.price),
	asks: mirror(up.bids).sort((a, b) => a.price - b.price),
})

export const bestOf = (b: Book) => ({
	bid: b.bids[0]?.price ?? null,
	ask: b.asks[0]?.price ?? null,
})

/* ------------------------------------------------------------------ *
 * CRC32 — OKX books checksum
 *
 * Build "bidPx:bidSz:askPx:askSz:..." alternating across the top 25 levels
 * of each side, then CRC32 the result and compare as a SIGNED 32-bit int.
 * If a side has fewer than 25 levels, its slots are simply skipped.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c
	}
	return table
})()

export function crc32(str: string): number {
	let crc = -1
	for (let i = 0; i < str.length; i++) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xff]!
	}
	return (crc ^ -1) | 0 // signed
}

/** Levels must already be sorted best-first. Raw strings preserve OKX formatting. */
export function bookChecksum(bids: string[][], asks: string[][]): number {
	const parts: string[] = []
	for (let i = 0; i < 25; i++) {
		const b = bids[i]
		const a = asks[i]
		if (b) parts.push(b[0]!, b[1]!)
		if (a) parts.push(a[0]!, a[1]!)
	}
	return crc32(parts.join(":"))
}