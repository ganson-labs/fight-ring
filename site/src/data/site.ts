// Facts about the project that are not in a season's files.
export const SITE = {
  name: 'Ринг моделей',
  repo: 'https://github.com/ganson-labs/fight-ring',
  /** the branch the links to files in the repository point at */
  branch: 'main',
  /** `npm start` serves the game here (serve.mjs) */
  localUrl: 'http://localhost:4848',
} as const;

export const repoFile = (path: string) => `${SITE.repo}/blob/${SITE.branch}/${path}`;
export const repoDir = (path: string) => `${SITE.repo}/tree/${SITE.branch}/${path}`;
