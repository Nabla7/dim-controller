// The sample's time is independent of gateway arrival time. Rendering uses milliseconds;
// epoch and clock remain separate so reset never joins two physical trajectories.
export interface AcquisitionHeader { clock_id: string; epoch: number | bigint; time_ns: number | bigint }
export const acquisitionKey = (h: AcquisitionHeader) => `${h.clock_id}:${h.epoch}`
// A new publisher clock starts a new binding; delayed packets from a retired
// run or an earlier epoch cannot restore an obsolete scene.
export class AcquisitionOrder {
    #clock: string | undefined
    #epoch: number | bigint = -1
    #retired = new Set<string>()
    accept(h: AcquisitionHeader): boolean {
        if (this.#retired.has(h.clock_id)) return false
        if (this.#clock !== h.clock_id) {
            if (this.#clock !== undefined) this.#retired.add(this.#clock)
            this.#clock = h.clock_id
            this.#epoch = -1
        }
        if (h.epoch < this.#epoch) return false
        this.#epoch = h.epoch
        return true
    }
}
export const acquisitionMs = (h: AcquisitionHeader) => Number(h.time_ns) / 1e6
