import path from 'node:path';

// This module lives at lib/project-paths.ts in source mode and
// dist/lib/project-paths.js after compilation. Anchor mutable/runtime paths to
// the project root so both layouts share data, views, and public assets.
const inferredProjectRoot = import.meta.url.endsWith('.ts')
  ? path.resolve(import.meta.dirname, '..')
  : path.resolve(import.meta.dirname, '..', '..');
const projectRoot = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : inferredProjectRoot;

function projectPath(...parts: string[]) {
  return path.join(projectRoot, ...parts);
}

export { projectPath, projectRoot };
