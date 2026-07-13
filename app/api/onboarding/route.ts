import { NextResponse } from "next/server";
import {
  getOnboarding,
  setOnboardingStep,
  completeOnboarding,
  resetOnboarding,
  type OnbStep,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

// First-run wizard state. GET reports where to resume; PATCH advances the saved
// step (so an abandoned setup reopens at the right place); POST finishes or
// skips it; DELETE re-arms it (the "Re-run setup" button in Settings).

export async function GET() {
  return NextResponse.json(getOnboarding());
}

export async function PATCH(req: Request) {
  const { step } = (await req.json()) as { step?: OnbStep };
  if (step) setOnboardingStep(step);
  return NextResponse.json(getOnboarding());
}

export async function POST() {
  completeOnboarding();
  return NextResponse.json(getOnboarding());
}

export async function DELETE() {
  resetOnboarding();
  return NextResponse.json(getOnboarding());
}
