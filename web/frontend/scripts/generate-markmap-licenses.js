import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = fileURLToPath(new URL('../', import.meta.url));
const metadataPath = path.resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const packages = new Map();

for (const output of Object.values(metadata.outputs || {})) {
    for (const [input, details] of Object.entries(output.inputs || {})) {
        if (details.bytesInOutput <= 0) continue;

        const marker = input.lastIndexOf('node_modules/');
        if (marker === -1) continue;

        const packagePath = input.slice(marker + 'node_modules/'.length);
        const parts = packagePath.split('/');
        const packageName = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const packageRootRelative = input.slice(0, marker + 'node_modules/'.length + packageName.length);
        const packageRoot = path.resolve(frontendDir, packageRootRelative);
        packages.set(packageRoot, packageName);
    }
}

const notices = [
    'Third-party license notices for the bundled Markmap renderer.',
    'Each section reproduces the license file from the corresponding npm package.',
    '',
];

for (const [packageRoot, packageName] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const files = await readdir(packageRoot);
    const licenseFiles = files.filter((file) => /^license(?:[-_.].*)?$/i.test(file));
    if (licenseFiles.length === 0) {
        throw new Error(`Missing license file for bundled package ${packageName}@${packageJson.version}`);
    }

    notices.push(`## ${packageName}@${packageJson.version} -- ${packageJson.license || 'license not specified'}`, '');
    for (const licenseFile of licenseFiles.sort()) {
        const licenseText = (await readFile(path.join(packageRoot, licenseFile), 'utf8')).trim();
        notices.push(`### ${licenseFile}`, '', licenseText, '');
    }
}

const vendorDir = path.join(frontendDir, 'vendor/markmap');
const noticesPath = path.join(vendorDir, 'THIRD_PARTY_NOTICES.txt');
await writeFile(noticesPath, `${notices.join('\n')}\n`);

const manifestPath = path.join(frontendDir, 'vendor/MANIFEST.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const markmapPackage = JSON.parse(await readFile(path.join(frontendDir, 'node_modules/markmap-lib/package.json'), 'utf8'));
const hashFile = async (filePath) => createHash('sha256').update(await readFile(filePath)).digest('hex');
manifest.packages.markmap.version = markmapPackage.version;
manifest.packages.markmap.hashes = {
    'markmap.js': await hashFile(path.join(vendorDir, 'markmap.js')),
    'markmap.js.LEGAL.txt': await hashFile(path.join(vendorDir, 'markmap.js.LEGAL.txt')),
    'THIRD_PARTY_NOTICES.txt': await hashFile(noticesPath),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
