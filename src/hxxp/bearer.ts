export function extractBearer(authHeader: string | undefined): string {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("missing bearer token");
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new Error("empty bearer token");
  return token;
}
