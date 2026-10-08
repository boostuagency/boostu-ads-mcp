import type { ClientEntry } from "./types.js";

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** True when every token of the query occurs in the candidate (order independent). */
export function fuzzyMatch(query: string, candidate: string): boolean {
  const c = normalize(candidate);
  return normalize(query)
    .split(" ")
    .filter(Boolean)
    .every((t) => c.includes(t));
}

export function findClient(clients: ClientEntry[], query: string): ClientEntry | undefined {
  const q = normalize(query);
  const aliases = (c: ClientEntry) => c.aliases ?? [];
  return (
    clients.find((c) => normalize(c.name) === q || aliases(c).some((a) => normalize(a) === q)) ??
    clients.find((c) => fuzzyMatch(query, c.name) || aliases(c).some((a) => fuzzyMatch(query, a)))
  );
}

/** Parses a registry from JSON text: either an array or { clients: [...] }. */
export function parseClients(json: string): ClientEntry[] {
  const parsed = JSON.parse(json);
  const list = Array.isArray(parsed) ? parsed : parsed?.clients;
  if (!Array.isArray(list)) throw new Error("Client registry must be a JSON array or { clients: [...] }");
  for (const c of list) if (typeof c?.name !== "string") throw new Error("Every client registry entry needs a name");
  return list as ClientEntry[];
}
