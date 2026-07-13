import { getProject } from "@/lib/store";
import { subscribeServices, listServices, serviceLogs } from "@/lib/services";
import type { ServiceEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Watch a project's services as SSE: a `snapshot` (current services + captured
 * logs) followed by a live tail of status/log events from the in-process service
 * supervisor (lib/services.ts). Reconnect-safe — each connect re-snapshots — and
 * fan-out-safe. Closing the stream never touches the running processes.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: ServiceEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      const unsub = subscribeServices(id, (ev) => {
        try { send(ev); } catch { cleanup(); }
      });
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { cleanup(); }
      }, 25_000);
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        unsub();
        clearInterval(ping);
        try { controller.close(); } catch { /* already closed */ }
      };
      send({ type: "snapshot", services: listServices(project), logs: serviceLogs(id) });
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
