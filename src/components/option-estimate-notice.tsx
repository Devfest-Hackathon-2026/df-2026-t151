import type { RecommendationOption } from '@/lib/api/types';

export function OptionEstimateNotice({
    option,
    showUnknownDetails = false,
}: {
    option: RecommendationOption;
    showUnknownDetails?: boolean;
}) {
    const unknowns = option.warnings.filter(({ code }) => code.startsWith('UNCONFIRMED_'));
    const visibleUnknowns = unknowns.filter(
        ({ code }) =>
            showUnknownDetails ||
            code === 'UNCONFIRMED_OPENING' ||
            code === 'UNCONFIRMED_BUSINESS_STATUS',
    );
    if (!option.time.isProvisional && !unknowns.length) return null;
    const waitWarning = option.warnings.find(({ code }) => code === 'ESTIMATED_WAIT');
    return (
        <div className="alert">
            <p>暫定候補：待ち時間などに推定・不明を含みます。</p>
            {waitWarning && <p>{waitWarning.message}</p>}
            {unknowns.length > 0 && (
                <>
                    <p>
                        {showUnknownDetails
                            ? '利用前に確認が必要な不明事項'
                            : '利用条件に不明な項目があります。行程画面で確認してください。'}
                    </p>
                    {visibleUnknowns.length > 0 && (
                        <ul>
                            {visibleUnknowns.map(({ code, message }) => (
                                <li key={code}>{message}</li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
