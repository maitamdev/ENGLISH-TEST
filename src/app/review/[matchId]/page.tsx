import { MatchReviewLoader } from "@/components/review/match-review";

export default async function MatchReviewPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <MatchReviewLoader matchId={matchId} />;
}
