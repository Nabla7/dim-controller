// Icons: dimos-react's shared dimOS line icons, plus this app's own workspace ones (by `path`).
import { Icon as LibIcon } from "dimos-react"

const OWN_ICON_PATHS: Record<string, string> = {
    // a window lifted off the one under it (pop out: float)
    float: "M9 9h12v11H9z M15 5H3v11h3",
    // a frame with a picture filling its middle (make this the main view)
    main: "M3 4h18v16H3z M7 8h10v8H7z",
    // a frame with a rail down its left side (dock into a rail)
    dock: "M3 4h18v16H3z M9 4v16 M5 8h2 M5 11h2",
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return <LibIcon name={name} path={OWN_ICON_PATHS[name]} size={size} />
}
