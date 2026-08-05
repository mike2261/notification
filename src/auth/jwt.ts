export type ParsedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
};

export function jsonBytes(obj: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function b64url(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function parseJwt(jwt: string): ParsedJwt {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("jwt: malformed token");
  }
  return {
    header: decodeJsonPart(parts[0]),
    payload: decodeJsonPart(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: b64urlDecode(parts[2]),
  };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("jwt: malformed token");
  return decodeJsonPart(parts[1]);
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const text = new TextDecoder().decode(b64urlDecode(part));
  const decoded = JSON.parse(text) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("jwt: decoded part is not an object");
  }
  return decoded as Record<string, unknown>;
}
