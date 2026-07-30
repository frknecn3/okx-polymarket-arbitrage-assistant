"use client"

import { useEffect, useRef, useState } from "react"
import { quoteKey, type Asset, type FeedMessage, type Quote } from "@/types/clientFeed"

export type Quotes = Record<string, Quote>

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001"
const RETRY_MS = 1500

export function useArbFeed() {
	const [quotes, setQuotes] = useState<Quotes>({})
	const [connected, setConnected] = useState(false)
	const [lastMessageAt, setLastMessageAt] = useState<number>(0)
	const wsRef = useRef<WebSocket | null>(null)

	useEffect(() => {
		let retry: ReturnType<typeof setTimeout> | undefined
		let stopped = false

		function connect() {
			try {
				const ws = new WebSocket(WS_URL)
				wsRef.current = ws

				ws.onopen = () => setConnected(true)

				ws.onmessage = (e) => {
					const raw = e.data as string
					// Keepalive frames are bare strings, not JSON.
					if (raw === "ping" || raw === "pong") return

					let msg: FeedMessage
					try {
						msg = JSON.parse(raw)
					} catch {
						return
					}

					setLastMessageAt(Date.now())

					if (msg.kind === "quote") {
						const q = msg
						setQuotes((prev) => ({ ...prev, [quoteKey(q.source, q.asset, q.slot)]: q }))
					} else if (msg.kind === "event-switch") {
						// Prune only this source+asset's rolled-off windows, so the
						// other assets' ladders survive a roll.
						const sw = msg
						setQuotes((prev) => {
							const next: Quotes = {}
							for (const [k, q] of Object.entries(prev)) {
								const sameFeed = q.source === sw.source && q.asset === sw.asset
								if (sameFeed && q.endsAt <= Date.now()) continue
								next[k] = q
							}
							return next
						})
					}
				}

				ws.onclose = () => {
					setConnected(false)
					if (!stopped) retry = setTimeout(connect, RETRY_MS)
				}

				ws.onerror = () => ws.close() // funnel into onclose → reconnect
			} catch {
				if (!stopped) retry = setTimeout(connect, RETRY_MS)
			}
		}

		connect()

		return () => {
			stopped = true
			if (retry) clearTimeout(retry)
			wsRef.current?.close()
		}
	}, [])

	return { quotes, connected, lastMessageAt }
}

export type { Asset, Quote }