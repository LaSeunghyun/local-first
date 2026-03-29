import React from 'react';
import type { Store } from '@local-first/store';
import { StoreContext } from './context.js';

interface StoreProviderProps {
  store: Store;
  children: React.ReactNode;
}

export function StoreProvider({ store, children }: StoreProviderProps): React.ReactElement {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
