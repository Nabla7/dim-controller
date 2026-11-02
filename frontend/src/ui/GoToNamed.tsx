// "Go to": once dimos's NamedLocations module has sent its locations (core/namedLocations.ts), a button in the bar (a
// phone: its corners) listing them; a click on a name sends the robot there (/go_to_location_label).
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Button, Card } from "dimos-react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Icon } from "./icons.tsx"
import { popoverPosition } from "./panelDrag.ts"

export function GoToNamed({ app, className = "" }: { app: ViewerApp; className?: string }) {
    const { locations } = useStore(app.namedLocations.state)
    const [open, setOpen] = useState(false)
    const [problem, setProblem] = useState<string | null>(null)
    const button = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".go-to-named, .go-to-named-menu")) {
                setOpen(false)
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [open])
    if (!locations) {
        return null
    }
    const goTo = (name: string) => {
        setProblem(null)
        app.namedLocations.goTo(name).then(() => setOpen(false), (error) => setProblem(`Couldn't send it: ${error instanceof Error ? error.message : error}`))
    }
    return (
        <>
            <Button
                ref={button}
                className={`go-to-named ${className}`}
                pressed={open}
                aria-haspopup="menu"
                aria-expanded={open}
                title="Send the robot to a named location"
                onClick={() => setOpen(!open)}
                data-testid="go-to-named"
            >
                <Icon name="pin" size={15} />
                <span>Go to</span>
            </Button>
            {open && createPortal(
                <Card padded={false} className="quality-menu go-to-named-menu" role="menu" aria-label="Go to" data-testid="go-to-named-menu" style={popoverPosition(button.current, 236)}>
                    {locations.length === 0 && <div className="go-to-named-empty">No named locations yet: right-click the 3D view to label one.</div>}
                    {locations.map((location) => (
                        <button key={location.id} type="button" role="menuitem" className="quality-option" data-testid="go-to-named-item" data-name={location.id} onClick={() => goTo(location.id)}>
                            <span className="quality-name">{location.label}</span>
                        </button>
                    ))}
                    {problem && <div className="go-to-named-empty">{problem}</div>}
                </Card>,
                document.body,
            )}
        </>
    )
}
