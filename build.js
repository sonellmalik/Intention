// Build script that explicitly disables code signing
// Usage:
//   node build.js          → builds for current platform
//   node build.js win      → builds Windows .exe installer
//   node build.js mac      → builds macOS .dmg (must run on macOS)
//   node build.js all      → builds both (macOS host only)

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
process.env.CSC_LINK = 'none';
process.env.WIN_CSC_LINK = 'none';
delete process.env.WIN_CSC_LINK;
delete process.env.CSC_LINK;

const builder = require('electron-builder');
const platform = process.argv[2] || (process.platform === 'darwin' ? 'mac' : 'win');

const sharedConfig = {
    appId: 'com.focusflow.app',
    productName: 'Intention',
    directories: { output: 'dist' },
    files: [
        'main.js',
        'preload.js',
        'mini.html',
        'index.html',
        'greyscale-helper.ps1',
        'foreground-title.ps1',
        'list-windows.ps1',
        'css/**/*',
        'js/**/*'
    ],
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        signAndEditExecutable: false,
        sign: null
    },
    mac: {
        target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
        identity: null,
        category: 'public.app-category.productivity'
    },
    dmg: {
        title: 'Intention',
        contents: [
            { x: 130, y: 220 },
            { x: 410, y: 220, type: 'link', path: '/Applications' }
        ]
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'Intention'
    },
    forceCodeSigning: false,
    // Auto-update feed. electron-builder uses this to generate the update
    // metadata (latest.yml / latest-mac.yml) and to embed the feed URL in the
    // app so electron-updater knows where to look. The GitHub provider is
    // configured as a single object (not an array) to satisfy the config schema.
    publish: {
        provider: 'github',
        owner: 'sonellmalik',
        repo: 'Intention'
    }
};

let targets;
if (platform === 'mac') {
    targets = builder.Platform.MAC.createTarget('dmg');
} else if (platform === 'win') {
    targets = builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64);
} else if (platform === 'all') {
    targets = new Map([
        ...builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
        ...builder.Platform.MAC.createTarget('dmg')
    ]);
} else {
    console.error('Unknown platform:', platform);
    process.exit(1);
}

console.log(`Building for: ${platform}...`);

builder.build({
    targets,
    config: sharedConfig,
    // Generate update metadata locally but never upload from the build itself —
    // the GitHub Actions "release" job attaches the artifacts to the release.
    // This prevents the "artifacts will be published" path that requires GH_TOKEN
    // and conflicts with the workflow's own release step.
    publish: 'never'
}).then(result => {
    console.log('\nBuild complete!');
    console.log('Output:', result);
}).catch(err => {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
});
