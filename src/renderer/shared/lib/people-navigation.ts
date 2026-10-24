export type PeopleScope = 'actors' | 'creators';

export interface PeopleView {
	tab: 'browse' | 'manage';
	query: string;
	archived: boolean;
	selectedId: string;
	scrollTop: number;
}

export function createPeopleView(): PeopleView {
	return { tab: 'browse', query: '', archived: false, selectedId: '', scrollTop: 0 };
}
