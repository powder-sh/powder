// bound the memory (and DB row size) a remote command's output can take.
// Keeps the first HEAD chars and the last TAIL chars; everything in between is
// dropped and replaced by a marker. An untrusted repo's test script / build can
// otherwise stream gigabytes into powder-worker.

const OUTPUT_HEAD_CHARS = 256 * 1024
const OUTPUT_TAIL_CHARS = 1024 * 1024
export const OUTPUT_TRUNCATED_MARKER = '[... output truncated ...]'

export class CappedOutput {
	private head = ''
	private tail = ''
	private dropped = 0
	constructor(
		private readonly headMax = OUTPUT_HEAD_CHARS,
		private readonly tailMax = OUTPUT_TAIL_CHARS,
	) {}

	push(s: string): void {
		if (!s) return
		if (this.head.length < this.headMax) {
			const take = s.slice(0, this.headMax - this.head.length)
			this.head += take
			s = s.slice(take.length)
			if (!s) return
		}
		this.tail += s
		// Trim lazily (at 2x) so a flood of small chunks does not re-slice 1 MB each time.
		if (this.tail.length > this.tailMax * 2) {
			this.dropped += this.tail.length - this.tailMax
			this.tail = this.tail.slice(-this.tailMax)
		}
	}

	/** Put text in front of everything kept (a small banner; may exceed the head cap slightly). */
	prepend(s: string): void {
		this.head = s + this.head
	}

	get truncated(): boolean {
		return this.dropped > 0 || this.tail.length > this.tailMax
	}

	toString(): string {
		if (this.tail.length > this.tailMax) {
			return `${this.head}\n${OUTPUT_TRUNCATED_MARKER}\n${this.tail.slice(-this.tailMax)}`
		}
		if (this.dropped > 0) return `${this.head}\n${OUTPUT_TRUNCATED_MARKER}\n${this.tail}`
		return this.head + this.tail
	}
}
