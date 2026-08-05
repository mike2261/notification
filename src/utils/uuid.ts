import { getRandomValues, type UUID } from "node:crypto";
import { type } from "arktype";

export const UUIDBranded = type("string.uuid").pipe((s: UUID): UUID => s);

const HEX: string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).substring(1));

class UUIDv7Generator {
  // Timestamp of the last generated UUID
  private lastTimestamp: number = -1;
  // Sequence counter for the same millisecond (12 bits = 4096 IDs per ms)
  private sequence: number = 0;

  public generate(): UUID {
    // 1. Get current time
    let timestamp = Date.now();

    // 2. Handle Monotonicity (Sequence Logic)
    const SEQUENCE_LIMIT = 0x0fff; // 4095

    if (timestamp > this.lastTimestamp) {
      // New millisecond: Reset sequence.
      // We initialize with a random value to make the sequence start unpredictable.
      this.lastTimestamp = timestamp;

      // Secure random start for the sequence (prevent guessing volume)
      const seed = new Uint8Array(2);
      getRandomValues(seed);
      // Mask to 12 bits
      this.sequence = ((seed[0] << 8) | seed[1]) & SEQUENCE_LIMIT;
    } else {
      // Same millisecond: Increment sequence
      this.sequence = (this.sequence + 1) & SEQUENCE_LIMIT;

      // Handle Overflow: > 4096 IDs in 1ms
      if (this.sequence === 0) {
        // We exceeded the sequence limit. Increment timestamp logically
        // to preserve sort order without failing.
        this.lastTimestamp++;
        timestamp = this.lastTimestamp;
      }
    }

    // 3. Generate Random Tail (62 bits)
    // We generate a fresh random tail every time for maximum security.
    const randomTail = new Uint8Array(8);
    getRandomValues(randomTail);

    // 4. Construct the UUID Buffer (16 bytes)
    const buffer = new Uint8Array(16);
    const view = new DataView(buffer.buffer);

    // -- Bytes 0-5: Timestamp (48 bits) --
    view.setUint32(0, Math.floor(timestamp / 0x10000)); // Top 32 bits
    view.setUint16(4, timestamp & 0xffff); // Bottom 16 bits

    // -- Bytes 6-7: Version (4 bits) + Sequence (12 bits) --
    // Version 7 is 0x7. Combined with top 4 bits of sequence.
    buffer[6] = 0x70 | (this.sequence >>> 8);
    // Bottom 8 bits of sequence
    buffer[7] = this.sequence & 0xff;

    // -- Bytes 8-15: Variant (2 bits) + Random Tail (62 bits) --
    buffer.set(randomTail, 8);
    // Set Variant to 10xx (RFC 9562)
    buffer[8] = (buffer[8] & 0x3f) | 0x80;

    // 5. Format as Hex String (8-4-4-4-12)
    return (HEX[buffer[0]] +
      HEX[buffer[1]] +
      HEX[buffer[2]] +
      HEX[buffer[3]] +
      "-" +
      HEX[buffer[4]] +
      HEX[buffer[5]] +
      "-" +
      HEX[buffer[6]] +
      HEX[buffer[7]] +
      "-" +
      HEX[buffer[8]] +
      HEX[buffer[9]] +
      "-" +
      HEX[buffer[10]] +
      HEX[buffer[11]] +
      HEX[buffer[12]] +
      HEX[buffer[13]] +
      HEX[buffer[14]] +
      HEX[buffer[15]]) as UUID;
  }
}

const generator = new UUIDv7Generator();

export function uuidV7(): UUID {
  return generator.generate();
}

export function uuidV4() {
  return crypto.randomUUID() as UUID;
}
