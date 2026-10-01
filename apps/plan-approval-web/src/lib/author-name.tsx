import * as React from "react";

const KEY = "plan-approval.author";

type AuthorName = [string, (name: string) => void];

const AuthorContext = React.createContext<AuthorName | undefined>(undefined);

/** The reviewer's self-declared name, remembered in this browser. Unverified. */
export function AuthorProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = React.useState(() => window.localStorage.getItem(KEY) ?? "");
  const remember = React.useCallback((next: string) => {
    setName(next);
    window.localStorage.setItem(KEY, next);
  }, []);
  const value = React.useMemo<AuthorName>(() => [name, remember], [name, remember]);
  return <AuthorContext.Provider value={value}>{children}</AuthorContext.Provider>;
}

export function useAuthorName(): AuthorName {
  const value = React.useContext(AuthorContext);
  if (!value) throw new Error("useAuthorName is used outside AuthorProvider.");
  return value;
}

/** The trimmed name, or undefined while none is set. */
export function useAuthor(): string | undefined {
  const [name] = useAuthorName();
  const trimmed = name.trim();
  return trimmed === "" ? undefined : trimmed;
}
