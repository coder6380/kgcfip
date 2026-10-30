import { coloCountryMap } from './colo.ts';

export const EXCLUDED_REGION_COUNTRY_CODES = new Set([
    'bh', 'lu', 'sc', 'mu', 'fj', 'qa', 'kw', 'si', 'sv', 'lb', 'ee', 'lv', 'lt',
]);

export function isRegionCountrySelectable(countryCode: string | undefined): boolean {
    return !countryCode || !EXCLUDED_REGION_COUNTRY_CODES.has(countryCode.toLowerCase());
}

export function isColoSelectable(colo: string): boolean {
    return isRegionCountrySelectable(coloCountryMap[colo.trim().toUpperCase()]);
}

export function matchesSelectedColo(colo: string | undefined, selectedColos: ReadonlySet<string>): boolean {
    if (selectedColos.size === 0) return true;
    if (!colo || colo === '-') return false;
    return selectedColos.has(colo.trim().toUpperCase());
}

export function isRegionQualifiedResult(
    result: { isAvailable: boolean; colo?: string },
    selectedColos: ReadonlySet<string>,
): boolean {
    return result.isAvailable && matchesSelectedColo(result.colo, selectedColos);
}
