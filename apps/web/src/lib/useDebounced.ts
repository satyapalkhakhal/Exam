// src/lib/useDebounced.ts
// Why: the email preview calls the API; debouncing keeps it to one call per pause in typing.

import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
