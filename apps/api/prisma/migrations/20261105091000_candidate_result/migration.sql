-- HR's shortlist/reject outcome moves out of candidates.status into its own
-- column (docs/superpowers/specs/2026-11-05-candidate-result-column-design.md).
-- The status keeps exam progress only; the CandidateStatus values SHORTLISTED /
-- REJECTED stay in the enum for old history rows but are no longer written.

-- CreateEnum
CREATE TYPE "CandidateResult" AS ENUM ('SHORTLISTED', 'REJECTED');

-- AlterTable
ALTER TABLE "candidate_status_history" ADD COLUMN     "from_result" "CandidateResult",
ADD COLUMN     "to_result" "CandidateResult";

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "result" "CandidateResult",
ADD COLUMN     "result_at" TIMESTAMPTZ(6),
ADD COLUMN     "result_by_id" UUID;

-- CreateIndex
CREATE INDEX "candidates_job_role_id_result_idx" ON "candidates"("job_role_id", "result");

-- CreateIndex
CREATE INDEX "candidates_result_by_id_idx" ON "candidates"("result_by_id");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_result_by_id_fkey" FOREIGN KEY ("result_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing decisions: copy them into result (with when/who from the latest
-- matching history row, if any) and put the status back to EVALUATED, the only
-- status a decision could be made from.
-- BACKFILL START
UPDATE candidates c
SET result = c.status::text::"CandidateResult", result_at = h.created_at, result_by_id = h.by_admin_id, status = 'EVALUATED'
FROM (
  SELECT DISTINCT ON (candidate_id) candidate_id, created_at, by_admin_id
  FROM candidate_status_history
  WHERE to_status IN ('SHORTLISTED', 'REJECTED')
  ORDER BY candidate_id, created_at DESC
) h
WHERE c.status IN ('SHORTLISTED', 'REJECTED') AND h.candidate_id = c.id;

UPDATE candidates
SET result = status::text::"CandidateResult", status = 'EVALUATED'
WHERE status IN ('SHORTLISTED', 'REJECTED');
-- BACKFILL END
