export const formatTimestamp = (value: string): string => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查');

export function feedDate(value: string, dateOnly = false): string {
	if (!value) {
		return '未提供';
	}
	if (dateOnly) {
		const calendarDate = value.match(/^(\d{4})[-./](\d{2})[-./](\d{2})/);
		if (calendarDate) {
			return `${calendarDate[1]}/${calendarDate[2]}/${calendarDate[3]}`;
		}
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.valueOf())
		? '未提供'
		: parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(!dateOnly && { hour: '2-digit', minute: '2-digit' }), hour12: false });
}
