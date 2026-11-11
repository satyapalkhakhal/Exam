-- MCQ questions (docs/superpowers/specs/2026-11-10-mcq-questions-design.md).
-- Additive only: a question type (WRITTEN default, MCQ = 4 options + one correct),
-- per-round negative marking, the per-attempt MCQ snapshot (shown option order,
-- re-mapped correct index, auto mark), the candidate's choice, the attempt's MCQ
-- subtotal, and marks widened to two decimals so quarter-mark deductions are exact.
-- Every existing question and attempt stays WRITTEN with identical marks.

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('WRITTEN', 'MCQ');

-- AlterTable
ALTER TABLE "exam_rounds" ADD COLUMN     "mcq_negative_marks" DECIMAL(4,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "correct_option" SMALLINT,
ADD COLUMN     "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "type" "QuestionType" NOT NULL DEFAULT 'WRITTEN',
ALTER COLUMN "max_marks" SET DATA TYPE DECIMAL(8,2);

-- AlterTable
ALTER TABLE "exam_attempts" ADD COLUMN     "mcq_marks" DECIMAL(8,2),
ADD COLUMN     "mcq_max_marks" DECIMAL(8,2) NOT NULL DEFAULT 0,
ALTER COLUMN "total_marks" SET DATA TYPE DECIMAL(8,2),
ALTER COLUMN "max_marks" SET DATA TYPE DECIMAL(8,2);

-- AlterTable
ALTER TABLE "attempt_questions" ADD COLUMN     "auto_marks" DECIMAL(8,2),
ADD COLUMN     "correct_snapshot" SMALLINT,
ADD COLUMN     "negative_marks_snapshot" DECIMAL(4,2) NOT NULL DEFAULT 0,
ADD COLUMN     "options_snapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "type_snapshot" "QuestionType" NOT NULL DEFAULT 'WRITTEN',
ALTER COLUMN "max_marks_snapshot" SET DATA TYPE DECIMAL(8,2);

-- AlterTable
ALTER TABLE "answers" ADD COLUMN     "selected_option" SMALLINT;

-- AlterTable
ALTER TABLE "question_evaluations" ALTER COLUMN "marks" SET DATA TYPE DECIMAL(8,2);

-- AlterTable
ALTER TABLE "ai_question_scores" ALTER COLUMN "marks" SET DATA TYPE DECIMAL(8,2),
ALTER COLUMN "max_marks" SET DATA TYPE DECIMAL(8,2);

