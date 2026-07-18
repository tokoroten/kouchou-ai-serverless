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

export function navigate(path: string, options?: { replace?: boolean }): void {
  // replace: 履歴を積まずに現在のエントリを差し替える(旧ルートの読み替え用)。
  // replaceState は hashchange を発火しないため、自分で通知する。
  if (options?.replace) {
    window.history.replaceState(null, "", `#${path}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = path;
}
