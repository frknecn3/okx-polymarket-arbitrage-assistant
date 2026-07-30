const OKX = process.env.OKX_BASE_URL ?? "https://www.okx.com"

async function probe() {
    const res = await fetch(`${OKX}/api/v5/public/event-contract/series`, {
        headers: { Accept: "application/json" },
    })
    const json = await res.json()
    console.log(`code=${json.code} msg=${json.msg}`)
    console.log(JSON.stringify(json.data, null, 2))
}

probe()