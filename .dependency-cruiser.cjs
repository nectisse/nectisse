const renderer = '^src/renderer/';
const features = ['work-query', 'library', 'subscriptions', 'updates', 'settings'];
const entities = ['work', 'subscription', 'update'];
const mainFeatures = ['metadata', 'library', 'magnets', 'subscriptions'];
const platforms = ['python', 'network', 'diagnostics', 'lifecycle'];

function publicModules(root, names) {
	return names.map((name) => ({
		name: `${root.replaceAll('/', '-')}-${name}-public-interface`,
		severity: 'error',
		from: { path: '^src/', pathNot: `^${root}/${name}/` },
		to: { path: `^${root}/${name}/`, pathNot: `^${root}/${name}/index\\.ts$` },
	}));
}

function independentFeatures(root, names) {
	return names.map((name) => ({
		name: `${root.replaceAll('/', '-')}-${name}-independent`,
		severity: 'error',
		from: { path: `^${root}/${name}/` },
		to: { path: `^${root}/`, pathNot: `^${root}/${name}/` },
	}));
}

module.exports = {
	forbidden: [
		{ name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
		{ name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
		{
			name: 'desktop-owns-renderer-data-libraries',
			severity: 'error',
			from: { path: '^src/', pathNot: '^src/renderer/shared/desktop/' },
			to: { path: '^node_modules/(zustand|@tanstack/(react-query|query-core))/' },
		},
		{
			name: 'desktop-public-interface',
			severity: 'error',
			from: { path: renderer, pathNot: '^src/renderer/shared/desktop/' },
			to: { path: '^src/renderer/shared/desktop/', pathNot: '^src/renderer/shared/desktop/index\\.ts$' },
		},
		{
			name: 'shared-is-platform-independent',
			severity: 'error',
			from: { path: '^src/shared/' },
			to: { path: '^src/(main|preload|renderer)/|^(node:|electron$|node_modules/electron/)' },
		},
		{ name: 'renderer-is-sandboxed', severity: 'error', from: { path: renderer }, to: { path: '^src/(main|preload)/|^(node:|electron$|node_modules/electron/)' } },
		{ name: 'renderer-has-no-node-builtins', severity: 'error', from: { path: renderer }, to: { dependencyTypes: ['core'] } },
		{ name: 'shared-has-no-node-builtins', severity: 'error', from: { path: '^src/shared/' }, to: { dependencyTypes: ['core'] } },
		{ name: 'main-has-no-ui', severity: 'error', from: { path: '^src/(main|preload)/' }, to: { path: renderer } },
		{
			name: 'renderer-shared-has-no-business-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/shared/' },
			to: { path: '^src/renderer/(app|features|entities|demo)/' },
		},
		{
			name: 'ui-primitives-have-no-desktop-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/shared/(ui|components)/' },
			to: { path: '^src/renderer/shared/desktop/' },
		},
		{
			name: 'entities-have-no-feature-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/entities/' },
			to: { path: '^src/renderer/(features|app|demo)/' },
		},
		{
			name: 'features-have-no-app-dependencies',
			severity: 'error',
			from: { path: '^src/renderer/features/' },
			to: { path: '^src/renderer/(app|demo)/' },
		},
		{
			name: 'production-does-not-import-demo',
			severity: 'error',
			from: { path: renderer, pathNot: '^src/renderer/(demo/|app/App\\.tsx$|app/styles/)' },
			to: { path: '^src/renderer/demo/' },
		},
		{
			name: 'main-platform-has-no-business-dependencies',
			severity: 'error',
			from: { path: '^src/main/platform/' },
			to: { path: '^src/main/(features/|index\\.ts$)' },
		},
		{
			name: 'main-features-have-no-entry-dependencies',
			severity: 'error',
			from: { path: '^src/main/features/' },
			to: { path: '^src/main/index\\.ts$' },
		},
		{
			name: 'subscription-image-cache-has-no-execution-dependencies',
			severity: 'error',
			from: { path: '^src/main/features/subscriptions/image-cache\\.ts$' },
			to: { path: '^src/main/features/subscriptions/(image-backfill|follow-runner|subscription-scheduler|subscriptions-service)\\.ts$' },
		},
		{
			name: 'subscription-runners-have-no-coordination-dependencies',
			severity: 'error',
			from: { path: '^src/main/features/subscriptions/(image-backfill|follow-runner)\\.ts$' },
			to: { path: '^src/main/features/subscriptions/(subscription-scheduler|subscriptions-service)\\.ts$' },
		},
		{
			name: 'subscription-scheduler-has-no-facade-dependencies',
			severity: 'error',
			from: { path: '^src/main/features/subscriptions/subscription-scheduler\\.ts$' },
			to: { path: '^src/main/features/subscriptions/subscriptions-service\\.ts$' },
		},
		...publicModules('src/renderer/features', features),
		...publicModules('src/renderer/entities', entities),
		...publicModules('src/renderer', ['demo']),
		...publicModules('src/main/features', mainFeatures),
		...publicModules('src/main/platform', platforms),
		...independentFeatures('src/renderer/features', features),
		...independentFeatures('src/main/features', mainFeatures),
	],
	options: {
		doNotFollow: { path: 'node_modules' },
		tsPreCompilationDeps: true,
		parser: 'swc',
		enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
	},
};
