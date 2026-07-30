"use client"

import { useEffect, useMemo, useState } from "react"
import { useArbFeed } from "../../hooks/useArbFeed"
import {
	ASSETS,
	quoteKey,
	TARGET_SIZE,
	type Asset,
	type Book,
	type EffLeg,
	type Level,
	type Quote,
	type Side,
} from "@/types/clientFeed"

const DEPTH = 8
const SLOT_COUNT = 3
const OKX_SETTLE_FEE = 0.02 // placeholder — real curve is K2 × C × (P × (1-P))
const POLY_FEE = 0.0
const PAYOUT = 1 - OKX_SETTLE_FEE - POLY_FEE

const GROUPINGS = [
	{ label: "raw", value: 0 },
	{ label: "0.01", value: 0.01 },
] as const

const visible = (ls: Level[]) => ls.slice(0, DEPTH)

/** Tail bands tick at 0.001, so 2dp would silently merge distinct levels. */
const fmtP = (p: number | null | undefined) =>
	p == null || !Number.isFinite(p) ? "—" : p < 0.04 || p > 0.96 ? p.toFixed(3) : p.toFixed(2)

const fmtS = (s: number) =>
	s >= 1000 ? `${(s / 1000).toFixed(1)}k` : String(Math.round(s * 10) / 10)

function fmtCountdown(ms: number) {
	if (!Number.isFinite(ms) || ms <= 0) return "0:00"
	const t = Math.floor(ms / 1000)
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`
}

/**
 * Display-only bucketing. Bids round down, asks round up, so a bucket never
 * advertises a better price than actually rests inside it.
 * Epsilon guards float division (0.96 / 0.01 === 95.99999999999999).
 */
function groupLevels(ls: Level[], side: "bid" | "ask", g: number): Level[] {
	if (!g) return ls
	const buckets = new Map<number, Level>()
	for (const l of ls) {
		const units = l.price / g
		const idx = side === "bid" ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9)
		const price = Math.round(idx * g * 1000) / 1000
		const hit = buckets.get(price)
		if (hit) hit.size += l.size
		else buckets.set(price, { price, size: l.size })
	}
	const out = [...buckets.values()]
	out.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price))
	return out
}

const btn = (active: boolean) => ({
	padding: "2px 8px",
	fontSize: 11,
	borderRadius: 4,
	cursor: "pointer",
	border: `1px solid ${active ? "#3a3a3a" : "#2a2a2a"}`,
	background: active ? "#242424" : "transparent",
	color: active ? "#eaeaea" : "#888",
})

function Ladder({
	title,
	book,
	best,
	grouping,
}: {
	title: string
	book: Book
	best: Side
	grouping: number
}) {
	const asks = visible(groupLevels(book.asks, "ask", grouping))
	const bids = visible(groupLevels(book.bids, "bid", grouping))

	// Spread comes from the RAW touch, never from bucketed prices.
	const spread = best.ask != null && best.bid != null ? best.ask - best.bid : null

	return (
		<div style={{ flex: 1, minWidth: 150 }}>
			<div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{title}</div>
			<div style={{ display: "flex", fontSize: 10, color: "#666", marginBottom: 2 }}>
				<span style={{ flex: 1 }}>price</span>
				<span>size</span>
			</div>

			{asks.length === 0 ? (
				<div style={{ fontSize: 11, color: "#555", padding: "2px 0" }}>no asks</div>
			) : (
				[...asks].reverse().map((l: Level) => (
					<div
						key={`a${l.price}`}
						style={{
							display: "flex",
							fontSize: 11,
							color: "#ff5c5c",
							background: "rgba(255,92,92,0.15)",
							padding: "1px 2px",
						}}
					>
						<span style={{ flex: 1 }}>{fmtP(l.price)}</span>
						<span>{fmtS(l.size)}</span>
					</div>
				))
			)}

			<div style={{ fontSize: 10, color: "#666", padding: "2px 0" }}>
				spread {spread == null ? "—" : spread.toFixed(3)}
			</div>

			{bids.length === 0 ? (
				<div style={{ fontSize: 11, color: "#555", padding: "2px 0" }}>no bids</div>
			) : (
				bids.map((l: Level) => (
					<div
						key={`b${l.price}`}
						style={{
							display: "flex",
							fontSize: 11,
							color: "#26c281",
							background: "rgba(38,194,129,0.15)",
							padding: "1px 2px",
						}}
					>
						<span style={{ flex: 1 }}>{fmtP(l.price)}</span>
						<span>{fmtS(l.size)}</span>
					</div>
				))
			)}
		</div>
	)
}

function Venue({ q, name, grouping }: { q: Quote | undefined; name: string; grouping: number }) {
	if (!q) {
		return (
			<div
				style={{
					flex: 1,
					background: "#151515",
					border: "1px solid #2a2a2a",
					borderRadius: 8,
					padding: 10,
				}}
			>
				<div style={{ fontSize: 12, color: "#888" }}>{name}</div>
				<div style={{ fontSize: 11, color: "#555", marginTop: 8 }}>no market</div>
			</div>
		)
	}

	const age = Date.now() - q.ts

	return (
		<div
			style={{
				flex: 1,
				background: "#151515",
				border: "1px solid #2a2a2a",
				borderRadius: 8,
				padding: 10,
			}}
		>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
				<span style={{ fontSize: 12, color: "#eaeaea" }}>{name}</span>
				<span style={{ fontSize: 10, color: "#666" }}>{q.eventTitle}</span>
			</div>
			<div style={{ display: "flex", gap: 12, marginTop: 8 }}>
				<Ladder title="UP" book={q.upBook} best={q.up} grouping={grouping} />
				<Ladder title="DOWN" book={q.downBook} best={q.down} grouping={grouping} />
			</div>
			<div style={{ fontSize: 10, color: age > 5000 ? "#ff5c5c" : "#555", marginTop: 6 }}>
				{Math.round(age / 1000)}s ago
			</div>
		</div>
	)
}

/** Use the sweep price only when it genuinely fills the target size. */
const askOf = (leg: EffLeg | undefined, top: number | null): number | null =>
	leg && leg.px != null && leg.filled >= TARGET_SIZE ? leg.px : top

export default function ArbWidget() {
	const { quotes, connected, lastMessageAt } = useArbFeed()
	const [asset, setAsset] = useState<Asset>("BTC")
	const [slot, setSlot] = useState(0)
	const [grouping, setGrouping] = useState<number>(0.01)
	const [now, setNow] = useState(Date.now())

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 250)
		return () => clearInterval(t)
	}, [])

	const okx = quotes[quoteKey("okx", asset, slot)]
	const poly = quotes[quoteKey("polymarket", asset, slot)]

	const legs = useMemo(() => {
		if (!okx || !poly) return null

		// Arb math always uses the RAW book — grouping is presentation only.
		const okxUp = askOf(okx.eff?.upAsk, okx.up.ask)
		const okxDown = askOf(okx.eff?.downAsk, okx.down.ask)
		const polyUp = askOf(poly.eff?.upAsk, poly.up.ask)
		const polyDown = askOf(poly.eff?.downAsk, poly.down.ask)

		const out: Array<{ label: string; cost: number; edge: number }> = []
		if (okxUp != null && polyDown != null) {
			const cost = okxUp + polyDown
			out.push({ label: "OKX Up + Poly Down", cost, edge: PAYOUT - cost })
		}
		if (polyUp != null && okxDown != null) {
			const cost = polyUp + okxDown
			out.push({ label: "Poly Up + OKX Down", cost, edge: PAYOUT - cost })
		}
		return out.sort((a, b) => b.edge - a.edge)
	}, [okx, poly])

	const best = legs?.[0]
	const endsAt = okx?.endsAt ?? poly?.endsAt ?? 0

	return (
		<div className="bg-stone-900 px-16 py-16 border rounded-xl" style={{ color: "#eaeaea" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
				<span style={{ fontSize: 11, color: connected ? "#26c281" : "#ff5c5c" }}>
					● {connected ? "live" : "offline"}
				</span>

				{ASSETS.map((a: Asset) => (
					<button key={a} onClick={() => setAsset(a)} style={btn(a === asset)}>
						{a}
					</button>
				))}

				<span style={{ width: 8 }} />

				{Array.from({ length: SLOT_COUNT }, (_, i) => (
					<button key={i} onClick={() => setSlot(i)} style={btn(i === slot)}>
						{i === 0 ? "Live" : `+${i * 5}m`}
					</button>
				))}

				<span style={{ marginLeft: "auto", fontSize: 11, color: "#888" }}>
					ends in {fmtCountdown(endsAt - now)}
				</span>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
				<span style={{ fontSize: 11, color: "#666" }}>group</span>
				{GROUPINGS.map((g) => (
					<button
						key={g.label}
						onClick={() => setGrouping(g.value)}
						style={btn(g.value === grouping)}
					>
						{g.label}
					</button>
				))}
				<span style={{ fontSize: 10, color: "#555" }}>
					{grouping ? "matches okx.com ladder" : "true executable levels"}
				</span>
			</div>

			<div style={{ fontSize: 10, color: "#555", marginTop: 6 }}>
				{Object.keys(quotes).length} quote key(s) · last msg{" "}
				{lastMessageAt ? `${Math.round((now - lastMessageAt) / 1000)}s ago` : "never"}
			</div>

			<div
				style={{
					marginTop: 10,
					padding: 10,
					borderRadius: 8,
					background: best && best.edge > 0 ? "rgba(38,194,129,0.15)" : "#111",
					border: `1px solid ${best && best.edge > 0 ? "#26c281" : "#2a2a2a"}`,
					fontSize: 12,
				}}
			>
				{!legs || legs.length === 0 ? (
					<span style={{ color: "#888" }}>
						{okx && poly ? "waiting for two-sided quotes" : "waiting for both venues"}
					</span>
				) : best && best.edge > 0 ? (
					<span style={{ color: "#26c281" }}>
						{best.label} — cost {best.cost.toFixed(3)}, edge +{best.edge.toFixed(3)} per contract
					</span>
				) : (
					<span style={{ color: "#888" }}>
						No arbitrage right now (net of {OKX_SETTLE_FEE.toFixed(3)} fees)
					</span>
				)}
			</div>

			<div style={{ display: "flex", gap: 12, marginTop: 12 }}>
				<Venue q={okx} name="OKX" grouping={grouping} />
				<Venue q={poly} name="Polymarket" grouping={grouping} />
			</div>
		</div>
	)
}