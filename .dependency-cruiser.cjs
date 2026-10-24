module.exports = {
	forbidden: [
		{ name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
		{
			name: 'state-public-interface',
			severity: 'error',
			from: { path: '^src/renderer/src/', pathNot: '^src/renderer/src/state/' },
			to: { path: '^src/renderer/src/state/', pathNot: '^src/renderer/src/state/index\\.ts$' },
		},
		{ name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
		{
			name: 'shared-is-platform-independent',
			severity: 'error',
			from: { path: '^src/shared/' },
			to: { path: '^src/(main|preload|renderer)/|^(node:|electron$|node_modules/electron/)' },
		},
		{ name: 'renderer-is-sandboxed', severity: 'error', from: { path: '^src/renderer/' }, to: { path: '^src/(main|preload)/|^(node:|electron$|node_modules/electron/)' } },
		{ name: 'renderer-has-no-node-builtins', severity: 'error', from: { path: '^src/renderer/' }, to: { dependencyTypes: ['core'] } },
		{ name: 'shared-has-no-node-builtins', severity: 'error', from: { path: '^src/shared/' }, to: { dependencyTypes: ['core'] } },
		{ name: 'main-has-no-ui', severity: 'error', from: { path: '^src/(main|preload)/' }, to: { path: '^src/renderer/' } },
		{
			name: 'state-has-no-view-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/src/state/' },
			to: { path: '^src/renderer/src/(app|components|metadata|works|library|subscriptions|updates|settings|prototype)/' },
		},
		{
			name: 'ui-primitives-have-no-business-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/src/components/' },
			to: { path: '^src/renderer/src/(app|state|metadata|works|library|subscriptions|updates|settings|prototype)/' },
		},
		{
			name: 'production-does-not-import-demo',
			severity: 'error',
			from: { path: '^src/renderer/src/', pathNot: '^src/renderer/src/(prototype/|app/Workspace\\.tsx$|styles\\.css$)' },
			to: { path: '^src/renderer/src/prototype/' },
		},
		{
			name: 'pages-do-not-import-other-pages',
			severity: 'error',
			from: { path: '^src/renderer/src/(metadata|works|library|subscriptions|updates|settings)/' },
			to: { path: '^src/renderer/src/(metadata/MetadataWorkspace|library/LibraryPage|subscriptions/SubscriptionsPage|settings/SettingsPage|updates/UpdatesPage)\\.tsx$' },
		},
		{
			name: 'work-presentation-does-not-import-pages',
			severity: 'error',
			from: { path: '^src/renderer/src/works/' },
			to: { path: '^src/renderer/src/(metadata|library|subscriptions|updates|settings)/' },
		},
	],
	options: {
		doNotFollow: { path: 'node_modules' },
		tsPreCompilationDeps: true,
		parser: 'swc',
		enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
	},
};
