-- "Evaluated" is no longer a candidate status (user decision 2026-11-16): the status
-- keeps saying how the exam ended, and being evaluated (a submitted evaluation on the
-- live attempt) is shown under Result. Data only: move every candidate still on the
-- retired EVALUATED status back to how their live attempt ended. Marks, evaluations
-- and results are untouched. The enum value stays (old history rows use it).

UPDATE candidates c
SET status = (CASE WHEN a.status = 'AUTO_SUBMITTED' THEN 'AUTO_SUBMITTED' ELSE 'SUBMITTED' END)::"CandidateStatus",
    updated_at = now()
FROM exam_attempts a
WHERE a.candidate_id = c.id
  AND a.status IN ('SUBMITTED', 'AUTO_SUBMITTED')
  AND c.status = 'EVALUATED';

-- Defensive: an EVALUATED candidate without a live submitted attempt (should not exist).
UPDATE candidates SET status = 'SUBMITTED', updated_at = now() WHERE status = 'EVALUATED';
