import type { SettingsSection } from '@/features/settings';
import { createPeopleView, type PeopleView } from '@/shared/lib/people-navigation';

export type Page = 'query' | 'library' | 'actors' | 'creators' | 'settings';

export interface WorkspaceNavigation {
	page: Page;
	settingsSection: SettingsSection;
	actors: PeopleView;
	creators: PeopleView;
	scrollTop: number;
}

export function createWorkspaceNavigation(): WorkspaceNavigation {
	return { page: 'query', settingsSection: 'sources', actors: createPeopleView(), creators: createPeopleView(), scrollTop: 0 };
}
