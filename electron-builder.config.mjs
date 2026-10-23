export default {
	appId: 'app.nectisse.desktop',
	productName: 'Nectisse',
	asar: true,
	directories: { output: 'dist', buildResources: 'resources' },
	files: ['out/**/*', 'package.json'],
	extraResources: [
		{ from: 'resources/icons/icon-macos.png', to: 'icons/icon-macos.png' },
		{
			from: '.build/python/darwin-${arch}',
			to: 'python',
			filter: ['runtime/**/*', 'dependencies/**/*', 'manifest.json', '!**/__pycache__/**'],
		},
		{
			from: 'python',
			to: 'python/app',
			filter: ['bootstrap.py', 'src/**/*', 'vendor/**/*', '!**/__pycache__/**'],
		},
		{ from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
	],
	mac: {
		icon: 'resources/icons/icon.icns',
		target: ['dir'],
		category: 'public.app-category.productivity',
		identity: null,
	},
	artifactName: 'Nectisse-${version}-${arch}.${ext}',
};
