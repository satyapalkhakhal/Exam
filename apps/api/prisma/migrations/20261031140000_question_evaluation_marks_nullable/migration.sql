-- A draft evaluation may hold an evaluator's comment before any marks are
-- entered, so marks become optional. Submitting an evaluation still requires
-- non-null marks on every question (enforced in the evaluation service).
ALTER TABLE "question_evaluations" ALTER COLUMN "marks" DROP NOT NULL;
