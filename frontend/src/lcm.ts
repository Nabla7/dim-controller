// dimos LCM messages (dimos-react's decoder, with every dimos_lcm schema), typed for the app.
import { decodeLcm, encodeLcm, headerFrameId as libraryHeaderFrameId } from "dimos-react"

// deno-lint-ignore no-explicit-any
export type LcmValue = any
export const decode = decodeLcm as (type: string, bytes: Uint8Array) => LcmValue
export const encode = encodeLcm as (type: string, value: Record<string, LcmValue>) => Uint8Array
export const headerFrameId = libraryHeaderFrameId as (type: string, bytes: Uint8Array) => string | null
export { lcmFingerprint as fingerprint } from "dimos-react"
