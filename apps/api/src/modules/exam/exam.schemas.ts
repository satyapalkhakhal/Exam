// modules/exam/exam.schemas.ts
// The exam engine's request contracts, defined once in @exam/shared so the exam
// screen and the API validate the same shapes.

export {
  ApplicationParamsSchema,
  ApplicationQuestionParamsSchema,
  ExamEventsSchema,
  ExamStartSchema,
  SaveAnswerSchema,
  SubmitExamSchema,
  ANSWER_MAX_CHARS,
} from '@exam/shared';
