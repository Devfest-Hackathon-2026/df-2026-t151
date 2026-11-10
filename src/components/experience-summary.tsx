import type { RecommendationOption } from '@/lib/api/types';
import { GroundedSources } from './grounded-sources';

const experienceLabels = new Map([
    ['public-exterior-v2', '外観観察'],
    ['cafe-break-v1', 'カフェでひと休み'],
    ['light-meal-v1', '軽食を楽しむ'],
    ['small-exhibit-v1', '小さな展示を鑑賞'],
]);

/** Keep the activity and its Maps provenance visible in both comparison and selected plans. */
export function ExperienceSummary({ option }: { option: RecommendationOption }) {
    return (
        <div className="experience-summary">
            <p className="experience-label">
                {experienceLabels.get(option.experienceId) ?? '寄り道体験'}
            </p>
            <h3 className="experience-title">{option.title}</h3>
            <p className="experience-place">{option.place.label}</p>
            <p className="experience-description">{option.description}</p>
            <GroundedSources sources={option.sources} />
        </div>
    );
}
