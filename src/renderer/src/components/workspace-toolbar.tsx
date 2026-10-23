import { ChevronRight, Moon, Search, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function WorkspaceToolbar({
	page,
	theme,
	onQuery,
	onDemo,
	onTheme,
}: {
	page: string;
	theme: 'cream' | 'night';
	onQuery: () => void;
	onDemo: () => void;
	onTheme: () => void;
}): React.JSX.Element {
	const themeLabel = `切换到${theme === 'cream' ? '黑莓夜间' : '奶油档案'}`;
	return (
		<header className="toolbar workspace-toolbar window-drag">
			<nav className="breadcrumb" aria-label="当前位置">
				<span>私人资料库</span>
				<ChevronRight aria-hidden="true" />
				<span className="current">{page}</span>
			</nav>
			<div className="toolbar-right">
				<Button variant="ghost" size="sm" className="toolbar-query" aria-label="快速查询作品" title="查询作品（⌘K）" onClick={onQuery}>
					<Search />
					<span>查询作品</span>
					<kbd>⌘ K</kbd>
				</Button>
				<span className="toolbar-divider" aria-hidden="true" />
				<Button variant="ghost" size="sm" className="toolbar-demo" onClick={onDemo}>
					视觉演示
				</Button>
				<Button variant="ghost" size="icon-sm" className="toolbar-theme" aria-label={themeLabel} title={themeLabel} onClick={onTheme}>
					{theme === 'cream' ? <Moon /> : <Sun />}
				</Button>
			</div>
		</header>
	);
}
