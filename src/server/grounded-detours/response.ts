import { upstreamUnavailable } from '../google-http.ts';
import { PUBLIC_EXTERIOR_ID } from '../exterior-access.ts';
import { indoorKind, indoorProfiles } from '../experience-profiles.ts';
import { candidateConditions } from '../candidate-conditions.ts';
import { candidateExclusion } from '../candidate-diagnostics.ts';
import type { PlaceCandidate } from '../nearby-candidates';
import type { InteriorAccessEvidence } from '../interior-access';
import type { GroundedDetourInput, GroundedDetoursResult, GroundingEvidence } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyText = (value: unknown, max: number): value is string =>
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const normalizeEvidenceText = (value: string) =>
    value.normalize('NFKC').replace(/\s+/g, ' ').trim();
function parseMapsPlaceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const id = value.startsWith('places/') ? value.slice(7) : value;
    return /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : null;
}
function parseMapsUrl(value: unknown): string | null {
    if (!isNonEmptyText(value, 2048)) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.port &&
            (url.hostname === 'maps.google.com' ||
                (url.hostname === 'www.google.com' && url.pathname.startsWith('/maps')))
            ? value
            : null;
    } catch {
        return null;
    }
}

/** A generated ID alone is never identity/provenance. Use actual Maps grounding chunks and supports. */
export function parseGroundedDetours(
    payload: unknown,
    input: GroundedDetourInput,
    checkedAt: string,
): GroundedDetoursResult {
    if (!isRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length !== 1)
        throw upstreamUnavailable(false);
    const answer = payload.candidates[0];
    if (
        !isRecord(answer) ||
        answer.finishReason !== 'STOP' ||
        !isRecord(answer.content) ||
        !Array.isArray(answer.content.parts) ||
        answer.content.parts.length > 16
    )
        throw upstreamUnavailable(false);
    const answerText = answer.content.parts
        .filter(isRecord)
        .filter((part) => part.thought !== true && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    if (answerText.length > 24000) throw upstreamUnavailable(false);
    let data: unknown;
    try {
        data = JSON.parse(answerText.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1'));
    } catch {
        throw upstreamUnavailable(false);
    }
    if (!isRecord(data) || !Array.isArray(data.candidates) || data.candidates.length > 4)
        throw upstreamUnavailable(false);
    const metadata = isRecord(answer.groundingMetadata) ? answer.groundingMetadata : {};
    const chunks = metadata.groundingChunks ?? [];
    const supports = metadata.groundingSupports ?? [];
    if (
        !Array.isArray(chunks) ||
        chunks.length > 64 ||
        !Array.isArray(supports) ||
        supports.length > 128
    )
        throw upstreamUnavailable(false);
    const sources = chunks.map((chunk, index) => {
        const maps = isRecord(chunk) && isRecord(chunk.maps) ? chunk.maps : {};
        return {
            index,
            placeId: parseMapsPlaceId(maps.placeId),
            url: parseMapsUrl(maps.uri),
            title: isNonEmptyText(maps.title, 512) ? maps.title : null,
        };
    });
    const result: GroundedDetoursResult = {
        candidates: [],
        exclusions: [],
        attributions: [],
        warnings: [
            {
                code: 'AI_MAPS_GROUNDED',
                message:
                    '候補・体験・利用条件はGeminiがGoogle Mapsの情報を参照して選定したものです。現地の利用条件を確認してください',
            },
        ],
    };
    const excluded = new Set([...input.request.excludedPlaceIds, input.destination.placeId]);
    const reject = (reason: string, label = '出典未照合の候補') =>
        result.exclusions!.push({
            stage: 'grounding',
            placeLabel: label,
            reason,
            source: { provider: 'Gemini / Google Maps', url: null },
            facts: { mapsIdentityRequired: true },
        });
    for (const raw of data.candidates) {
        if (
            !isRecord(raw) ||
            !isNonEmptyText(raw.title, 160) ||
            !isNonEmptyText(raw.description, 1600)
        ) {
            reject('INVALID_CANDIDATE_DATA');
            continue;
        }
        const kind = raw.experienceKind ?? 'exterior';
        const indoor = indoorKind(kind);
        if (kind !== 'exterior' && !indoor) {
            reject('EXPERIENCE_UNSUPPORTED');
            continue;
        }
        const experienceId = indoor ? indoorProfiles[indoor].experienceId : PUBLIC_EXTERIOR_ID;
        if (input.selectedExperienceId && experienceId !== input.selectedExperienceId) {
            reject('EXPERIENCE_MISMATCH');
            continue;
        }
        const id = parseMapsPlaceId(raw.placeId);
        if (raw.placeId !== null && raw.placeId !== undefined && id === null) {
            reject('INVALID_PLACE_ID');
            continue;
        }
        const name = isNonEmptyText(raw.placeName, 512) ? raw.placeName : null;
        const matching = sources.filter(
            (source) =>
                source.placeId &&
                source.url &&
                source.title &&
                (id
                    ? source.placeId === id
                    : name && normalizeEvidenceText(name) === normalizeEvidenceText(source.title)),
        );
        const ids = new Set(matching.map((source) => source.placeId));
        if (ids.size !== 1) {
            reject('MAPS_IDENTITY_UNVERIFIED');
            continue;
        }
        const supportedSource = matching.find((source) =>
            supports.some(
                (support) =>
                    isRecord(support) &&
                    isRecord(support.segment) &&
                    isNonEmptyText(support.segment.text, 24000) &&
                    typeof raw.accessStatement === 'string' &&
                    normalizeEvidenceText(support.segment.text).includes(
                        normalizeEvidenceText(raw.accessStatement as string),
                    ) &&
                    Array.isArray(support.groundingChunkIndices) &&
                    support.groundingChunkIndices.includes(source.index),
            ),
        );
        const source = supportedSource ?? matching[0];
        if (
            !source?.placeId ||
            !source.title ||
            !source.url ||
            excluded.has(source.placeId) ||
            (input.selectedPlace && source.placeId !== input.selectedPlace.placeId)
        ) {
            reject('EXCLUDED_OR_MISMATCHED_PLACE', source?.title ?? undefined);
            continue;
        }
        const access = {
            placeId: source.placeId,
            destinationPlaceId: input.destination.placeId,
            outsideDestination:
                supportedSource && typeof raw.outsideDestination === 'boolean'
                    ? raw.outsideDestination
                    : null,
            provider: 'grounded_maps' as const,
            sourceUrl: source.url,
            checkedAt,
            validUntil: new Date(Date.parse(checkedAt) + 24 * 3600000).toISOString(),
            conditions:
                supportedSource && typeof raw.accessStatement === 'string'
                    ? raw.accessStatement
                    : '利用条件の根拠は不明',
        };
        let interiorAccessEvidence: InteriorAccessEvidence | undefined;
        if (indoor) {
            interiorAccessEvidence = {
                ...access,
                experienceId: indoorProfiles[indoor].experienceId,
                indoorConfirmed:
                    supportedSource && typeof raw.indoorConfirmed === 'boolean'
                        ? raw.indoorConfirmed
                        : null,
                walkInAllowed:
                    supportedSource && typeof raw.walkInAllowed === 'boolean'
                        ? raw.walkInAllowed
                        : null,
                noFixedStart:
                    supportedSource && typeof raw.noFixedStart === 'boolean'
                        ? raw.noFixedStart
                        : null,
                smallExhibition:
                    supportedSource && typeof raw.smallExhibition === 'boolean'
                        ? raw.smallExhibition
                        : null,
                admissionRequired:
                    supportedSource && typeof raw.admissionRequired === 'boolean'
                        ? raw.admissionRequired
                        : null,
                entryCutoff:
                    supportedSource && (raw.entryCutoff === 'none' || raw.entryCutoff === 'known')
                        ? raw.entryCutoff
                        : null,
                lastEntryAt:
                    supportedSource && typeof raw.lastEntryAt === 'string' ? raw.lastEntryAt : null,
            };
        }
        const candidate: PlaceCandidate = {
            place: { placeId: source.placeId, label: source.title, latitude: 0, longitude: 0 },
            types: [],
            businessStatus: null,
            opening: { status: 'unknown' },
            sourceUrl: source.url,
            retrievedAt: checkedAt,
            attributions: [],
            relations: { parentIds: [], childIds: [] },
            ...(interiorAccessEvidence
                ? { interiorAccessEvidence }
                : {
                      accessEvidence: {
                          ...access,
                          experienceId: PUBLIC_EXTERIOR_ID,
                          publicExteriorWithoutAdmission:
                              supportedSource &&
                              typeof raw.publicExteriorWithoutAdmission === 'boolean'
                                  ? raw.publicExteriorWithoutAdmission
                                  : null,
                      },
                  }),
        };
        const conditions = candidateConditions(candidate, input.destination.placeId, checkedAt);
        if (conditions.blockedReason) {
            result.exclusions!.push(
                candidateExclusion(conditions.blockedReason, candidate, 'grounding'),
            );
            continue;
        }
        excluded.add(source.placeId);
        const sourceLinks = sources
            .filter((item) => item.url && item.title)
            .map((item) => ({ title: item.title!, url: item.url! }));
        result.candidates.push({
            placeId: source.placeId,
            sourceTitle: source.title,
            sourceUrl: source.url,
            title: raw.title,
            description: raw.description,
            sources: sourceLinks,
            ...(interiorAccessEvidence
                ? { interiorAccessEvidence }
                : {
                      accessEvidence: {
                          ...access,
                          experienceId: PUBLIC_EXTERIOR_ID,
                          publicExteriorWithoutAdmission:
                              candidate.accessEvidence?.publicExteriorWithoutAdmission ?? null,
                      },
                  }),
        });
        for (const link of sourceLinks)
            if (
                !result.attributions.some(
                    (item) =>
                        typeof item === 'object' &&
                        item.providerUri === link.url &&
                        item.provider === `Google Maps：${link.title}`,
                )
            ) {
                result.attributions.push({
                    provider: `Google Maps：${link.title}`,
                    providerUri: link.url,
                });
            }
    }
    if (result.candidates.length < data.candidates.length)
        result.warnings.push({
            code: 'AI_EVIDENCE_MISSING',
            message:
                '場所を出典と照合できない候補や、利用できない条件が確認された候補は除外しました',
        });
    return result;
}

/** Preserve the original Maps metadata; generated extraction metadata is never evidence. */
export function prepareGroundingEvidence(
    payload: unknown,
): GroundingEvidence | GroundedDetoursResult {
    if (!isRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length !== 1)
        throw upstreamUnavailable(false);
    const grounded = payload.candidates[0];
    if (
        !isRecord(grounded) ||
        grounded.finishReason !== 'STOP' ||
        !isRecord(grounded.content) ||
        !Array.isArray(grounded.content.parts) ||
        grounded.content.parts.length > 16
    )
        throw upstreamUnavailable(false);
    const groundedText = grounded.content.parts
        .filter(isRecord)
        .filter((part) => part.thought !== true && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    if (!groundedText || groundedText.length > 24000) throw upstreamUnavailable(false);
    const metadata = isRecord(grounded.groundingMetadata) ? grounded.groundingMetadata : {};
    if (
        metadata.groundingChunks !== undefined &&
        (!Array.isArray(metadata.groundingChunks) || metadata.groundingChunks.length > 64)
    )
        throw upstreamUnavailable(false);
    const sources = ((metadata.groundingChunks ?? []) as unknown[])
        .filter(isRecord)
        .map((chunk) => (isRecord(chunk.maps) ? chunk.maps : {}))
        .filter(
            (maps) =>
                parseMapsPlaceId(maps.placeId) &&
                parseMapsUrl(maps.uri) &&
                isNonEmptyText(maps.title, 512),
        )
        .map((maps) => ({ placeId: parseMapsPlaceId(maps.placeId)!, title: maps.title as string }));
    if (!sources.length)
        return {
            candidates: [],
            attributions: [],
            warnings: [
                {
                    code: 'AI_EVIDENCE_MISSING',
                    message: 'Google Mapsの出典を取得できなかったため、AI候補は表示しません',
                },
            ],
        };
    const supports = metadata.groundingSupports;
    if (supports !== undefined && (!Array.isArray(supports) || supports.length > 128))
        throw upstreamUnavailable(false);
    const supportedStatements = [
        ...new Set(
            ((supports ?? []) as unknown[])
                .filter(isRecord)
                .filter(
                    (support) =>
                        isRecord(support.segment) &&
                        isNonEmptyText(support.segment.text, 1600) &&
                        normalizeEvidenceText(groundedText).includes(
                            normalizeEvidenceText(support.segment.text),
                        ) &&
                        Array.isArray(support.groundingChunkIndices) &&
                        support.groundingChunkIndices.length > 0,
                )
                .map((support) => (support.segment as Record<string, unknown>).text as string),
        ),
    ];
    if (supportedStatements.join('').length > 32000) throw upstreamUnavailable(false);
    // Keep long, variable source text out of the constrained decoding schema.
    const statementRefs = Object.fromEntries(
        supportedStatements.map((statement, index) => [`s${index}`, statement]),
    );

    return { answerText: groundedText, metadata, sources, statementRefs };
}

export function restoreStatementReferences(
    structured: unknown,
    metadata: Record<string, unknown>,
    statementRefs: Record<string, string>,
) {
    if (
        !isRecord(structured) ||
        !Array.isArray(structured.candidates) ||
        structured.candidates.length !== 1 ||
        !isRecord(structured.candidates[0])
    )
        throw upstreamUnavailable(false);
    const extracted = structured.candidates[0];
    if (
        !isRecord(extracted.content) ||
        !Array.isArray(extracted.content.parts) ||
        extracted.content.parts.length > 16
    )
        throw upstreamUnavailable(false);
    const extractedText = extracted.content.parts
        .filter(isRecord)
        .filter((part) => part.thought !== true && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    if (extractedText.length > 24000) throw upstreamUnavailable(false);
    let decoded: unknown;
    try {
        decoded = JSON.parse(extractedText);
    } catch {
        throw upstreamUnavailable(false);
    }
    if (!isRecord(decoded) || !Array.isArray(decoded.candidates) || decoded.candidates.length > 4)
        throw upstreamUnavailable(false);
    const restored = decoded.candidates.map((raw) => {
        if (!isRecord(raw)) return raw;
        const ref = raw.accessStatement;
        return {
            ...raw,
            accessStatement:
                typeof ref === 'string' && Object.hasOwn(statementRefs, ref)
                    ? statementRefs[ref]
                    : null,
        };
    });
    const combined = {
        ...structured,
        candidates: [
            {
                ...extracted,
                content: { parts: [{ text: JSON.stringify({ candidates: restored }) }] },
                groundingMetadata: metadata,
            },
        ],
    };

    return combined;
}
