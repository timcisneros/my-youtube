import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from './project-paths.js';

const publicDirectory = projectPath('public');
const runtimeAssetVersions = new Map<string, string>();

function safeRuntimeAssetName(assetName: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)) {
    throw new Error(`Invalid runtime asset name: ${assetName}`);
  }
  return assetName;
}

function runtimeAssetVersion(assetName: string) {
  const safeName = safeRuntimeAssetName(assetName);
  const cached = runtimeAssetVersions.get(safeName);
  if (cached) return cached;
  const contents = fs.readFileSync(path.join(publicDirectory, safeName));
  const version = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  runtimeAssetVersions.set(safeName, version);
  return version;
}

function runtimeAssetUrl(assetName: string) {
  const safeName = safeRuntimeAssetName(assetName);
  return `/${safeName}?v=${runtimeAssetVersion(safeName)}`;
}

export {
  runtimeAssetUrl,
  runtimeAssetVersion,
};
