const japanDateTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

export function displayTime(value: string) {
    return japanDateTime.format(new Date(value));
}

export function minutes(seconds: number) {
    return Math.ceil(seconds / 60);
}

export function initialDeadline(now = Date.now()) {
    const tokyoNow = new Date(now + 9 * 60 * 60 * 1000).toISOString();
    const tokyoLater = new Date(now + (9 * 60 + 90) * 60 * 1000).toISOString();
    return tokyoNow.slice(0, 10) === tokyoLater.slice(0, 10) ? tokyoLater.slice(0, 16) : '';
}
