// The robot-type icons the Launcher draws (public/robots: Portal's glow for dark, Research's ink for light).
import { useTheme } from "dimos-react"
import type { RobotType } from "../profile/types.ts"

export function RobotIcon({ type, size = 32 }: { type: RobotType; size?: number }) {
    const { dark } = useTheme()
    return <img className="robot-icon" src={`./robots/${type}${dark ? "" : "_research"}.svg`} width={size} height={size} alt="" aria-hidden="true" data-robot-type={type} />
}
