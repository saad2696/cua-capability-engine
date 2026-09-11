/**
 * A hash router in thirty lines.
 *
 * The console has four routes and no need for nested layouts, loaders or code splitting, so a
 * router dependency would be more moving parts than the problem has. Hash routing also means the
 * built console can be opened from a file path or served from any prefix without configuration.
 */
import { useEffect, useState } from "react";

export function useRoute() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1) || "/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);

  const [path, query = ""] = hash.split("?");
  const segments = path.split("/").filter(Boolean);
  return { path, segments, params: new URLSearchParams(query) };
}

export const go = (to) => {
  location.hash = to;
};

export function Link({ to, children, ...rest }) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}
