// Which topics make a map (dimos-react's Map2D helpers, typed for the app).
import * as lib from "dimos-react/three"
import type { Topic } from "./connection.ts"

export const mapCandidates = lib.mapCandidates as (topics: Topic[]) => Topic[]
export const overlayCandidates = lib.overlayCandidates as (topics: Topic[]) => Topic[]
export const chooseMapTopic = lib.chooseMapTopic as (topics: Topic[], picked: string) => Topic | null
export const chooseOverlay = lib.chooseOverlay as (topics: Topic[], picked: string, base: Topic | null) => Topic | null
export const isGridTopic = lib.isGridTopic as (topic: Topic) => boolean
export const followFrameOptions = lib.followFrameOptions as (frames: string[], chosen: string) => { frame: string; waiting: boolean }[]
