// Tests only: next/dynamic as React.lazy (Next's own build of it doesn't load under Vitest's module runner).
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

export default function dynamic<P extends object>(loader: () => Promise<ComponentType<P>>, opts: { loading?: () => ReactNode } = {}) {
  const Lazy = lazy(() => loader().then((component) => ({ default: component })));
  return function Dynamic(props: P) {
    return (
      <Suspense fallback={opts.loading ? opts.loading() : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
