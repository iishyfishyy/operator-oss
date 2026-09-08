"use client";
import { useEffect, useState } from "react";
import type { CustomCommand } from "@/lib/types";
import { jget } from "./api";

export function useCommands(projectId?: string) {
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    let version = 0;
    const reload = () => {
      const request = ++version;
      setLoading(true);
      jget<CustomCommand[]>(`/api/commands${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`)
        .then((rows) => { if (alive && request === version) { setCommands(rows); setError(""); } })
        .catch((e) => { if (alive && request === version) setError(e.message); })
        .finally(() => { if (alive && request === version) setLoading(false); });
    };
    reload();
    window.addEventListener("orch:commands-changed", reload);
    window.addEventListener("focus", reload);
    return () => { alive = false; window.removeEventListener("orch:commands-changed", reload); window.removeEventListener("focus", reload); };
  }, [projectId]);
  return { commands, error, loading };
}

export interface CommandDraft { taskId: string; name: string }
