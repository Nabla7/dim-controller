// The robot-type icons the Launcher draws (public/robots: Portal's glow for dark, Research's ink for light).
import { useEffect, useState } from "react"
import type { RobotType } from "../profile/types.ts"

const dark = () => document.body.classList.contains("dark")

export function RobotIcon({ type, size = 32 }: { type: RobotType; size?: number }) {
    const [isDark, setDark] = useState(dark)
    useEffect(() => {
        const update = () => setDark(dark())
        addEventListener("dim-theme", update)
        return () => removeEventListener("dim-theme", update)
    }, [])
    return <img className="robot-icon" src={`./robots/${type}${isDark ? "" : "_research"}.svg`} width={size} height={size} alt="" aria-hidden="true" data-robot-type={type} />
}
