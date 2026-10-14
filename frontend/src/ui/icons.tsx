// Icons: dimos-react's shared dimOS line icons, plus this app's own workspace ones (by `path`).
import { Icon as LibIcon } from "dimos-react"

const OWN_ICON_PATHS: Record<string, string> = {
    // a window lifted off the one under it (pop out: float)
    float: "M9 9h12v11H9z M15 5H3v11h3",
    // a frame with a picture filling its middle (make this the main view)
    main: "M3 4h18v16H3z M7 8h10v8H7z",
    // a frame with a rail down its left side (dock into a rail)
    dock: "M3 4h18v16H3z M9 4v16 M5 8h2 M5 11h2",
    // a camera's fit: |<->|, the whole width fits between the edges (no frame, so it can't read as "main view")
    fit: "M3 5v14M21 5v14 M6 12h12M9 9l-3 3 3 3M15 9l3 3-3 3",
    // a camera's fill: crop marks around a picture that runs past them
    fill: "M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4 M7 8h10v8H7z",
    // the map's "fit the whole map": a magnifier over a frame
    "fit-map": "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M15.5 15.5 20 20 M8 8.5h5v4H8z",
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return <LibIcon name={name} path={OWN_ICON_PATHS[name]} size={size} />
}
