import { useEffect, useState } from "react";

// ハッシュベースの極小ルータ(GitHub Pages のサブパス配信でも安全)。

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
