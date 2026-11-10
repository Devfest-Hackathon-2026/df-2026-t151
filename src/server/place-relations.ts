import { upstreamUnavailable } from './google-http.ts';

export interface PlaceRelations {
    parentIds: string[];
    childIds: string[];
}
export interface RelatedPlace {
    placeId: string;
    relations?: PlaceRelations;
}
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Missing repeated fields mean no reported relationship, never proof of public access. */
export function parsePlaceRelations(raw: unknown): PlaceRelations {
    if (!record(raw)) throw upstreamUnavailable();
    const ids = (value: unknown): string[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 32) throw upstreamUnavailable();
        return [
            ...new Set(
                value.map((item) => {
                    if (
                        !record(item) ||
                        typeof item.id !== 'string' ||
                        !/^[A-Za-z0-9_-]{1,256}$/.test(item.id) ||
                        (item.name !== undefined && item.name !== `places/${item.id}`)
                    )
                        throw upstreamUnavailable();
                    return item.id;
                }),
            ),
        ];
    };
    return { parentIds: ids(raw.containingPlaces), childIds: ids(raw.subDestinations) };
}

/**
 * Evaluate site relationships from reported place IDs and containment links.
 *
 * @param candidate - The proposed detour stop.
 * @param destination - The user's requested endpoint.
 * @param known - Previously fetched places that can link nested sites. Only the first six are used.
 * @returns An exclusion code, or `null` when the available links do not establish one.
 */
export function destinationExclusion(
    candidate: RelatedPlace,
    destination: RelatedPlace,
    known: readonly RelatedPlace[] = [],
): string | null {
    if (candidate.placeId === destination.placeId) return 'DESTINATION';
    const parents = new Map<string, Set<string>>();
    const link = (child: string, parent: string) => {
        if (!parents.has(child)) parents.set(child, new Set());
        parents.get(child)!.add(parent);
    };
    for (const place of [destination, candidate, ...known.slice(0, 6)]) {
        for (const id of place.relations?.parentIds ?? []) link(place.placeId, id);
        for (const id of place.relations?.childIds ?? []) link(id, place.placeId);
    }
    const ancestors = (id: string) => {
        const visited = new Set([id]);
        const queue = [id];
        for (let index = 0; index < queue.length && visited.size <= 512; index++) {
            for (const parent of parents.get(queue[index]) ?? [])
                if (!visited.has(parent)) {
                    visited.add(parent);
                    queue.push(parent);
                }
        }
        visited.delete(id);
        return visited;
    };
    const candidateParents = ancestors(candidate.placeId);
    const destinationParents = ancestors(destination.placeId);
    if (candidateParents.has(destination.placeId)) return 'DESTINATION_INTERIOR';
    if (destinationParents.has(candidate.placeId)) return 'DESTINATION_CONTAINER';
    if ([...candidateParents].some((id) => destinationParents.has(id)))
        return 'SAME_DESTINATION_SITE';
    return null;
}
