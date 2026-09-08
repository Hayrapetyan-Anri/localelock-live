import { useEffect, useMemo, useState } from 'react';

export function useCountdown(targetIso: string | null, serverNowIso: string | null): number | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const offset = useMemo(() => {
    if (!serverNowIso) return 0;
    const server = Date.parse(serverNowIso);
    return Number.isFinite(server) ? server - Date.now() : 0;
  }, [serverNowIso]);
  void tick;
  if (!targetIso) return null;
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return null;
  return target - (Date.now() + offset);
}
