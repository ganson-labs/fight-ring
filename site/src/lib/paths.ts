// Relative addresses: the site does not know where it is served from, as the game does not.
//   root('/fighters/astra50/')  →  '../../'
//   to('/fighters/astra50/', 'play/?screen=play')  →  '../../play/?screen=play'
export function root(pathname: string): string {
  const depth = pathname.split('/').filter(Boolean).length;
  return depth ? '../'.repeat(depth) : './';
}

export const to = (pathname: string, target: string) => root(pathname) + target.replace(/^\/+/, '');
