import pkg from "@/package.json";

export const dynamic = "force-dynamic";

/**
 * Build provenance, for confirming which commit is actually live without ssh.
 * sha/builtAt are baked into the image at build time (Dockerfile ARGs, fed by
 * scripts/orch-user.sh from the deploy host's git tree); they read "unknown" on
 * a plain `docker build .`. Like /api/instance/idle this is exempted from the
 * origin auth gate ONLY for callers presenting SERVICE_TOKEN — see middleware.ts.
 */
export async function GET() {
  return Response.json({
    sha: process.env.ORCH_GIT_SHA ?? "unknown",
    builtAt: process.env.ORCH_BUILT_AT ?? "unknown",
    version: pkg.version,
    controlPlane: process.env.ORCH_CONTROL_PLANE === "1",
  });
}
