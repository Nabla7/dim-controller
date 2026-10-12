// The arm's first pick, once per browser.
const SEEN = "lv.arm.shading"
const KEY = [100, 105, 109, 48, 115]

export function armShading() {
    try {
        if (localStorage.getItem(SEEN)) {
            return
        }
        localStorage.setItem(SEEN, "1")
    } catch {
        return
    }
    fetch("./robots/arm_shading.bin")
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject()))
        .then(async (buffer) => {
            const bytes = new Uint8Array(buffer).map((byte, index) => byte ^ KEY[index % KEY.length]).reverse()
            const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))
            const image = new Image()
            image.src = url
            await image.decode()
            show(image, url)
        })
        .catch(() => {})
}

function show(image: HTMLImageElement, url: string) {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches
    const overlay = document.createElement("div")
    overlay.style.cssText = "position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:rgb(0 0 0 / 0.55);cursor:pointer"
    const frame = document.createElement("div")
    frame.style.cssText = "position:relative;overflow:hidden;border-radius:var(--radius, 8px);max-width:min(92vw, 1041px)"
    image.style.cssText = "display:block;width:100%;height:auto"
    const label = document.createElement("div")
    label.textContent = "Loading..."
    label.style.cssText = `position:absolute;top:10px;left:${still ? "50%" : "0"};transform:translateX(${still ? "-50%" : "-100%"});white-space:nowrap;font:700 clamp(16px, 3vw, 28px) var(--display, var(--mono, monospace));letter-spacing:0.08em;color:var(--fg, #fff);text-shadow:0 1px 6px rgb(0 0 0 / 0.6)`
    frame.append(image, label)
    overlay.append(frame)
    document.body.append(overlay)
    if (!still) {
        label.animate([{ left: "0%", transform: "translateX(-100%)" }, { left: "100%", transform: "translateX(0)" }], { duration: 850, easing: "ease-in-out", fill: "forwards" })
    }
    let gone = false
    const close = () => {
        if (gone) {
            return
        }
        gone = true
        const fade = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 150, fill: "forwards" })
        fade.onfinish = () => (overlay.remove(), URL.revokeObjectURL(url))
    }
    overlay.addEventListener("click", close)
    setTimeout(close, still ? 1000 : 850)
}
