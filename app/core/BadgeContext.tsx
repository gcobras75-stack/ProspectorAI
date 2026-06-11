import React, { createContext, useContext, useState } from 'react';

interface BadgeContextValue {
  geologoBadge: boolean;
  setGeologoBadge: (v: boolean) => void;
}

const BadgeContext = createContext<BadgeContextValue>({
  geologoBadge: false,
  setGeologoBadge: () => {},
});

export function BadgeProvider({ children }: { children: React.ReactNode }) {
  const [geologoBadge, setGeologoBadge] = useState(false);
  return (
    <BadgeContext.Provider value={{ geologoBadge, setGeologoBadge }}>
      {children}
    </BadgeContext.Provider>
  );
}

export function useBadge() {
  return useContext(BadgeContext);
}
