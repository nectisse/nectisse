import type { MetadataRecord } from '@shared/metadata';

// 按来源顺序采用首个非空字段，未提供的值继续留空。
export function firstAvailableField<K extends keyof MetadataRecord>(records: MetadataRecord[], name: K): MetadataRecord[K] {
	return (records.find((record) => (Array.isArray(record[name]) ? record[name].length > 0 : typeof record[name] === 'string' && !!record[name].trim())) ?? records[0]!)[name];
}
