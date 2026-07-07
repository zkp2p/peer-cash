import { useEffect, useRef } from 'react';

/**
 * A ref that is `true` while the component is mounted. Used to guard `setState`
 * in the manually-triggered `refresh()` paths (the poll loop guards itself).
 * Internal — not exported from the package.
 */
export function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
